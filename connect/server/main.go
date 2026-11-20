// LivePL Connect — rendezvous server (AnyDesk-style).
// It assigns each host a short numeric ID, routes WebRTC signaling between a
// controller and a host by that ID, and serves the controller web UI. Media
// (screen frames / input) flows over WebRTC, encrypted end to end (DTLS):
// directly between the peers when the networks allow it, otherwise through the
// TURN relay (coturn) for which this server hands out short-lived credentials.
package main

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"math/big"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// Msg is the signaling frame exchanged over the control WebSocket.
type Msg struct {
	Type     string          `json:"type"`
	ID       string          `json:"id,omitempty"`       // host ID (register result / connect target)
	Key      string          `json:"key,omitempty"`      // host -> server on register: secret that owns the ID
	Password string          `json:"password,omitempty"` // controller -> host (verified by host)
	To       string          `json:"to,omitempty"`       // destination connId (routing)
	From     string          `json:"from,omitempty"`     // source connId (set by server)
	Data     json.RawMessage `json:"data,omitempty"`     // SDP / ICE payload
	Error    string          `json:"error,omitempty"`
	ICE      []iceServer     `json:"ice,omitempty"` // relay for this peer (set by server only)
}

// iceServer is a TURN relay entry in the WebRTC RTCIceServer format.
type iceServer struct {
	URLs       []string `json:"urls"`
	Username   string   `json:"username,omitempty"`
	Credential string   `json:"credential,omitempty"`
}

type client struct {
	connID   string
	hostID   string
	ip       string
	ws       *websocket.Conn
	send     chan []byte
	lastSeen atomic.Int64 // unix nanos of the last frame or pong from this peer
}

// owner records who owns a host ID. Only a SHA-256 of the host's secret key is
// kept, plus the day it last registered (records unused for a year expire).
type owner struct {
	K string `json:"k"`
	T int64  `json:"t"`
}

const (
	ownerTTLDays    = 365
	maxOwners       = 500000
	newOwnersPerIP  = 30 // new owned IDs per IP per hour (stops filling the file)
	replacedCloseIn = 2 * time.Second
)

var probeWait = 5 * time.Second // how long a probed holder has to answer (shorter in tests)

// TURN relay (coturn with use-auth-secret): credentials are HMAC-SHA1 of
// "<expiry>:<connID>" with the shared secret, valid for turnTTL.
var (
	turnSecret []byte
	turnURLs   []string
)

const turnTTL = 24 * time.Hour

var (
	upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mu       sync.RWMutex
	clients  = map[string]*client{} // connID -> client
	hosts    = map[string]string{}  // hostID -> connID

	owners      = map[string]owner{} // hostID -> owner (persisted)
	ownersFile  string
	ownersDirty bool
	newByIP     = map[string]int{}
	newByIPHour int64
)

func main() {
	addr := ":7000"
	if v := os.Getenv("CONNECT_ADDR"); v != "" {
		addr = v
	}
	webDir := "web"
	if v := os.Getenv("CONNECT_WEB"); v != "" {
		webDir = v
	}
	ownersFile = filepath.Join("dane", "id.json")
	if v := os.Getenv("CONNECT_IDS"); v != "" {
		ownersFile = v
	}
	loadOwners()
	go saveLoop()
	loadTURN()

	http.HandleFunc("/ws", serveWS)
	http.Handle("/", http.FileServer(http.Dir(webDir)))

	// If TLS cert+key are given, terminate TLS here (wss://). Otherwise plain ws://
	// (e.g. behind a reverse proxy or for local testing).
	cert := os.Getenv("CONNECT_TLS_CERT")
	keyFile := os.Getenv("CONNECT_TLS_KEY")
	if cert != "" && keyFile != "" {
		log.Printf("LivePL Connect rendezvous listening on %s (TLS, web: %s)", addr, webDir)
		log.Fatal(http.ListenAndServeTLS(addr, cert, keyFile, nil))
	}
	log.Printf("LivePL Connect rendezvous listening on %s (web: %s)", addr, webDir)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func serveWS(w http.ResponseWriter, r *http.Request) {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	ip, _, _ := net.SplitHostPort(r.RemoteAddr)
	c := &client{connID: randDigits(12), ip: ip, ws: ws, send: make(chan []byte, 64)}
	c.lastSeen.Store(time.Now().UnixNano())
	mu.Lock()
	clients[c.connID] = c
	mu.Unlock()

	go c.writeLoop()
	defer func() {
		mu.Lock()
		delete(clients, c.connID)
		if c.hostID != "" && hosts[c.hostID] == c.connID {
			delete(hosts, c.hostID)
		}
		mu.Unlock()
		_ = ws.Close()
	}()

	ws.SetReadLimit(1 << 20)
	// A peer that stops answering pings is dropped within ~75s, which frees its ID.
	extend := func() {
		c.lastSeen.Store(time.Now().UnixNano())
		_ = ws.SetReadDeadline(time.Now().Add(75 * time.Second))
	}
	extend()
	ws.SetPongHandler(func(string) error { extend(); return nil })
	for {
		_, data, err := ws.ReadMessage()
		if err != nil {
			return
		}
		extend()
		var m Msg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		handle(c, &m)
	}
}

func handle(c *client, m *Msg) {
	switch m.Type {
	case "register":
		register(c, m.ID, m.Key)

	case "connect":
		// Controller wants to reach host m.ID; forward to that host with the
		// controller's connID and the supplied password (host verifies it).
		mu.RLock()
		host := clients[hosts[m.ID]]
		mu.RUnlock()
		if host == nil {
			c.pushJSON(Msg{Type: "error", Error: "no online host with that ID"})
			return
		}
		host.pushJSON(Msg{Type: "connect", From: c.connID, Password: m.Password, ICE: turnFor(host.connID)})

	default:
		// Generic routed frame (offer/answer/ice/control-channel setup).
		if m.To == "" {
			return
		}
		mu.RLock()
		dst := clients[m.To]
		mu.RUnlock()
		if dst != nil {
			m.From = c.connID
			// Only the server hands out relays: the controller gets one with the
			// offer, i.e. only after the host has accepted the password.
			m.ICE = nil
			if m.Type == "offer" {
				m.ICE = turnFor(dst.connID)
			}
			b, _ := json.Marshal(m)
			dst.push(b)
		}
	}
}

// register gives the host its ID. A host asks for the ID it had before and,
// since 0.6.1, proves with its secret key that the ID is its own:
//   - owned ID, right key: granted; a stale connection still holding it gives way
//     (after a network change the old link can look alive for up to 75 s);
//   - owned ID, no key or another key: refused, the host gets a new ID;
//   - ID nobody owns yet (hosts before 0.6.1): granted when free; when another
//     connection holds it, that holder is pinged and loses it only if silent.
func register(c *client, requested, key string) {
	id, evicted, busy := assignHostID(c, requested, key, false, false)
	if busy != nil {
		go func() {
			start := time.Now().UnixNano()
			_ = busy.ws.WriteControl(websocket.PingMessage, nil, time.Now().Add(probeWait))
			time.Sleep(probeWait)
			stale := busy.lastSeen.Load() < start
			id, evicted, _ := assignHostID(c, requested, key, true, stale)
			finishRegister(c, id, evicted)
		}()
		return
	}
	finishRegister(c, id, evicted)
}

func finishRegister(c *client, id string, evicted *client) {
	if evicted != nil {
		// tell the old link (if anyone still reads it) and close it shortly after
		evicted.pushJSON(Msg{Type: "replaced"})
		time.AfterFunc(replacedCloseIn, func() { _ = evicted.ws.Close() })
	}
	if id != "" {
		c.pushJSON(Msg{Type: "registered", ID: id, From: c.connID})
	}
}

// assignHostID returns the granted ID, a connection that lost it, or (without
// granting anything) a connection that must first be probed for liveness.
// probed/stale carry the result of that probe on the second call.
func assignHostID(c *client, requested, key string, probed, stale bool) (string, *client, *client) {
	mu.Lock()
	defer mu.Unlock()
	if clients[c.connID] != c {
		return "", nil, nil // this peer has gone meanwhile
	}
	if c.hostID != "" {
		return c.hostID, nil, nil
	}
	kh := ""
	if validKey(key) {
		sum := sha256.Sum256([]byte(key))
		kh = hex.EncodeToString(sum[:])
	}
	today := time.Now().Unix() / 86400

	if isID(requested) {
		o, owned := owners[requested]
		holder := clients[hosts[requested]]
		if holder == c {
			holder = nil
		}
		switch {
		case owned && kh != "" && subtle.ConstantTimeCompare([]byte(o.K), []byte(kh)) == 1:
			if holder != nil {
				holder.hostID = ""
			}
			grant(c, requested, kh, today)
			return requested, holder, nil
		case !owned && holder == nil:
			grant(c, requested, kh, today)
			return requested, nil, nil
		case !owned && !probed:
			return "", nil, holder
		case !owned && stale:
			holder.hostID = ""
			grant(c, requested, kh, today)
			return requested, holder, nil
		}
		// otherwise: a live holder or a key that does not match, so a new ID
	}
	var id string
	for {
		id = randDigits(9)
		if _, taken := hosts[id]; taken {
			continue
		}
		if _, reserved := owners[id]; reserved {
			continue
		}
		break
	}
	grant(c, id, kh, today)
	return id, nil, nil
}

// grant hands the ID to c and records (or refreshes) its owner. Caller holds mu.
func grant(c *client, id, kh string, today int64) {
	hosts[id] = c.connID
	c.hostID = id
	if kh == "" {
		return
	}
	if o, ok := owners[id]; ok {
		if o.T != today {
			owners[id] = owner{K: o.K, T: today}
			ownersDirty = true
		}
		return
	}
	if len(owners) >= maxOwners {
		return
	}
	hour := time.Now().Unix() / 3600
	if hour != newByIPHour {
		newByIP = map[string]int{}
		newByIPHour = hour
	}
	if newByIP[c.ip] >= newOwnersPerIP {
		return
	}
	newByIP[c.ip]++
	owners[id] = owner{K: kh, T: today}
	ownersDirty = true
}

func validKey(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func isID(s string) bool {
	if len(s) != 9 {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// ----- owners file -----------------------------------------------------------

func loadOwners() {
	b, err := os.ReadFile(ownersFile)
	if err != nil {
		if !os.IsNotExist(err) {
			log.Fatalf("cannot read %s: %v", ownersFile, err)
		}
		return
	}
	var m map[string]owner
	if err := json.Unmarshal(b, &m); err != nil {
		// never start with an empty list over a damaged file: owned IDs would be up for grabs
		log.Fatalf("damaged %s: %v", ownersFile, err)
	}
	oldest := time.Now().Unix()/86400 - ownerTTLDays
	for id, o := range m {
		if isID(id) && len(o.K) == 64 && o.T >= oldest {
			owners[id] = o
		}
	}
	if len(owners) != len(m) {
		ownersDirty = true
	}
	log.Printf("owned IDs: %d", len(owners))
}

func saveLoop() {
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, os.Interrupt)
	t := time.NewTicker(2 * time.Second)
	for {
		select {
		case <-t.C:
			saveOwners()
		case <-stop:
			saveOwners()
			os.Exit(0)
		}
	}
}

func saveOwners() {
	mu.Lock()
	if !ownersDirty {
		mu.Unlock()
		return
	}
	b, err := json.Marshal(owners)
	ownersDirty = false
	mu.Unlock()
	if err == nil {
		err = writeAtomic(ownersFile, b)
	}
	if err != nil {
		log.Printf("saving owned IDs: %v", err)
		mu.Lock()
		ownersDirty = true
		mu.Unlock()
	}
}

func writeAtomic(path string, b []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err = f.Write(b); err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ----- connection plumbing -----------------------------------------------------

func (c *client) writeLoop() {
	ping := time.NewTicker(30 * time.Second)
	defer ping.Stop()
	defer c.ws.Close() // a failed write closes the socket so the reader exits and cleans up
	for {
		select {
		case b, ok := <-c.send:
			if !ok {
				return
			}
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if c.ws.WriteMessage(websocket.TextMessage, b) != nil {
				return
			}
		case <-ping.C:
			_ = c.ws.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if c.ws.WriteMessage(websocket.PingMessage, nil) != nil {
				return
			}
		}
	}
}

func (c *client) push(b []byte) {
	select {
	case c.send <- b:
	default:
	}
}

func (c *client) pushJSON(m Msg) {
	b, _ := json.Marshal(m)
	c.push(b)
}

// randDigits uses crypto/rand: connection IDs route signaling, so they must not
// be guessable, and math/rand was also shared between goroutines without a lock.
func randDigits(n int) string {
	b := make([]byte, n)
	ten := big.NewInt(10)
	for i := range b {
		d, err := rand.Int(rand.Reader, ten)
		if err != nil {
			panic(err)
		}
		b[i] = byte('0' + d.Int64())
	}
	return string(b)
}

func loadTURN() {
	secret := os.Getenv("CONNECT_TURN_SECRET")
	_ = os.Unsetenv("CONNECT_TURN_SECRET")
	for _, u := range strings.Split(os.Getenv("CONNECT_TURN_URLS"), ",") {
		u = strings.TrimSpace(u)
		if strings.HasPrefix(u, "turn:") || strings.HasPrefix(u, "turns:") {
			turnURLs = append(turnURLs, u)
		}
	}
	if secret == "" || len(turnURLs) == 0 {
		turnURLs = nil
		log.Printf("TURN relay: off")
		return
	}
	turnSecret = []byte(secret)
	log.Printf("TURN relay: %s", strings.Join(turnURLs, ", "))
}

// turnFor returns relay credentials for one connection, or nil when TURN is off.
func turnFor(connID string) []iceServer {
	if len(turnSecret) == 0 {
		return nil
	}
	user := fmt.Sprintf("%d:%s", time.Now().Add(turnTTL).Unix(), connID)
	mac := hmac.New(sha1.New, turnSecret)
	mac.Write([]byte(user))
	return []iceServer{{URLs: turnURLs, Username: user, Credential: base64.StdEncoding.EncodeToString(mac.Sum(nil))}}
}
