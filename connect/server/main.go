// LivePL Connect — rendezvous server (AnyDesk-style).
// It assigns each host a short numeric ID, routes WebRTC signaling between a
// controller and a host by that ID, and serves the controller web UI. It never
// sees the media (screen frames / input) — those flow peer-to-peer over WebRTC.
package main

import (
	"encoding/json"
	"log"
	"math/rand"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Msg is the signaling frame exchanged over the control WebSocket.
type Msg struct {
	Type     string          `json:"type"`
	ID       string          `json:"id,omitempty"`       // host ID (register result / connect target)
	Password string          `json:"password,omitempty"` // controller -> host (verified by host)
	To       string          `json:"to,omitempty"`       // destination connId (routing)
	From     string          `json:"from,omitempty"`     // source connId (set by server)
	Data     json.RawMessage `json:"data,omitempty"`     // SDP / ICE payload
	Error    string          `json:"error,omitempty"`
}

type client struct {
	connID string
	hostID string
	ws     *websocket.Conn
	send   chan []byte
}

var (
	upgrader = websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	mu       sync.RWMutex
	clients  = map[string]*client{} // connID -> client
	hosts    = map[string]string{}  // hostID -> connID
	rng      = rand.New(rand.NewSource(time.Now().UnixNano()))
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
	c := &client{connID: randDigits(12), ws: ws, send: make(chan []byte, 64)}
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
	extend := func() { _ = ws.SetReadDeadline(time.Now().Add(75 * time.Second)) }
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
		id := assignHostID(c, m.ID)
		c.pushJSON(Msg{Type: "registered", ID: id, From: c.connID})

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
		host.pushJSON(Msg{Type: "connect", From: c.connID, Password: m.Password})

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
			b, _ := json.Marshal(m)
			dst.push(b)
		}
	}
}

func assignHostID(c *client, requested string) string {
	mu.Lock()
	defer mu.Unlock()
	if c.hostID != "" {
		return c.hostID
	}
	// Honor a previously-held ID on reconnect, if it is a free 9-digit value.
	if isID(requested) {
		if _, taken := hosts[requested]; !taken {
			hosts[requested] = c.connID
			c.hostID = requested
			return requested
		}
	}
	var id string
	for {
		id = randDigits(9)
		if _, taken := hosts[id]; !taken {
			break
		}
	}
	hosts[id] = c.connID
	c.hostID = id
	return id
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

func randDigits(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte('0' + rng.Intn(10))
	}
	return string(b)
}
