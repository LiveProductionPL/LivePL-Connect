// LivePL Connect — host (the machine being controlled).
// Registers with the rendezvous server to get a short ID + a session password,
// then for each authorized controller it streams the screen over WebRTC (video
// data channel) and injects the controller's mouse/keyboard (ctrl channel).
// A visible banner is shown on the host for the whole session.
package main

import (
	"bytes"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"image/jpeg"
	"log"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"
)

type sigMsg struct {
	Type     string          `json:"type"`
	ID       string          `json:"id,omitempty"`
	Password string          `json:"password,omitempty"`
	To       string          `json:"to,omitempty"`
	From     string          `json:"from,omitempty"`
	Data     json.RawMessage `json:"data,omitempty"`
	Error    string          `json:"error,omitempty"`
}

const (
	frameInterval = 100 * time.Millisecond
	jpegQuality   = 45
	chunkPayload  = 16 * 1024
	frameHeader   = 8
	bufferedLimit = 2 * 1024 * 1024
)

var (
	conn   *websocket.Conn
	wsMu   sync.Mutex
	myID   string
	myPass string
	iceURLs   []string
	idFile    string
	announced bool

	sessMu   sync.Mutex
	sessions = map[string]*session{} // controller connID -> session
)

func main() {
	server := flag.String("server", "ws://localhost:7000/ws", "rendezvous WebSocket URL")
	stun := flag.String("stun", "", "comma-separated STUN/TURN URLs (needed across the internet)")
	idf := flag.String("idfile", "", "write {id,pass} JSON here once registered (used by the desktop app)")
	wantID := flag.String("id", "", "preferred 9-digit ID, kept across restarts (the server grants it if free)")
	flag.Parse()
	idFile = *idf
	if len(*wantID) == 9 && strings.Trim(*wantID, "0123456789") == "" {
		myID = *wantID
	}
	if *stun != "" {
		for _, u := range strings.Split(*stun, ",") {
			if u = strings.TrimSpace(u); u != "" {
				iceURLs = append(iceURLs, u)
			}
		}
	}
	if len(iceURLs) == 0 {
		// Default public STUN so connections work across NAT with no extra setup.
		iceURLs = []string{"stun:stun.l.google.com:19302"}
	}

	myPass = randDigits(6)
	loadPermanentPassword()

	// Reconnect loop: if the rendezvous link drops (network blip, server restart),
	// re-dial and re-register with the SAME ID so it stays stable. Active WebRTC
	// sessions flow peer-to-peer and keep running regardless of this link.
	for {
		if err := runConn(*server); err != nil {
			log.Printf("rendezvous link lost: %v (reconnecting in 3s)", err)
		}
		fmt.Println("STATUS offline")
		time.Sleep(3 * time.Second)
	}
}

func runConn(server string) error {
	c, _, err := websocket.DefaultDialer.Dial(server, nil)
	if err != nil {
		return err
	}
	wsMu.Lock()
	conn = c
	wsMu.Unlock()
	// ID is empty on first run (server assigns one) and reused on reconnect.
	sendSig(sigMsg{Type: "register", ID: myID})
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return err
		}
		var m sigMsg
		if json.Unmarshal(data, &m) != nil {
			continue
		}
		switch m.Type {
		case "registered":
			if !announced || myID != m.ID {
				myID = m.ID
				announced = true
				printReady()
			}
			fmt.Println("STATUS online")
		case "connect":
			if tooManyWrongTries() {
				log.Printf("connection from %s refused: too many wrong passwords recently", m.From)
				sendSig(sigMsg{Type: "error", To: m.From, Error: "too many attempts"})
				continue
			}
			if !passwordOK(m.Password) {
				noteWrongTry()
				log.Printf("connection from %s rejected: wrong password", m.From)
				// tell the controller, so it can show "wrong password" instead of waiting
				sendSig(sigMsg{Type: "error", To: m.From, Error: "wrong password"})
				continue
			}
			go startSession(m.From)
		case "answer":
			if s := getSession(m.From); s != nil {
				s.onAnswer(m.Data)
			}
		case "ice":
			if s := getSession(m.From); s != nil {
				s.onICE(m.Data)
			}
		}
	}
}

func printReady() {
	fmt.Println("========================================")
	fmt.Println("  LivePL Connect - ten komputer jest gotowy")
	fmt.Printf("  Twoje ID:  %s\n", formatID(myID))
	fmt.Printf("  Haslo:     %s\n", myPass)
	fmt.Println("  Podaj je osobie, ktora ma sie polaczyc.")
	fmt.Println("========================================")
	writeIDFile()
}

// writeIDFile hands the current ID + password to the desktop app through a small
// JSON file (atomic temp+rename, so the app never reads a half-written file).
func writeIDFile() {
	if idFile == "" {
		return
	}
	b, _ := json.Marshal(map[string]string{"id": myID, "pass": myPass})
	tmp := idFile + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return
	}
	_ = os.Rename(tmp, idFile)
}

// ----- session -------------------------------------------------------------

type session struct {
	peer       string
	pc         *webrtc.PeerConnection
	stop       chan struct{}
	closeOnce  sync.Once
	mu         sync.Mutex
	remoteSet  bool
	connected  bool
	pendingICE []webrtc.ICECandidateInit
}

// connectedSessions counts controllers that are really connected right now. The
// desktop app reads the "SESSIONS n" lines so it never auto-updates (and drops
// the link) while someone is working on this computer.
var connectedSessions int32

func (s *session) markConnected() {
	s.mu.Lock()
	already := s.connected
	s.connected = true
	s.mu.Unlock()
	if !already {
		fmt.Printf("SESSIONS %d\n", atomic.AddInt32(&connectedSessions, 1))
	}
}

func startSession(peer string) {
	cfg := webrtc.Configuration{}
	for _, u := range iceURLs {
		cfg.ICEServers = append(cfg.ICEServers, webrtc.ICEServer{URLs: []string{u}})
	}
	pc, err := webrtc.NewPeerConnection(cfg)
	if err != nil {
		log.Printf("peer connection: %v", err)
		return
	}
	s := &session{peer: peer, pc: pc, stop: make(chan struct{})}
	addSession(peer, s)

	ordered := false
	var zero uint16 = 0
	video, err := pc.CreateDataChannel("video", &webrtc.DataChannelInit{Ordered: &ordered, MaxRetransmits: &zero})
	if err != nil {
		_ = pc.Close()
		return
	}
	video.OnOpen(func() { go s.captureLoop(video) })

	ctrl, err := pc.CreateDataChannel("ctrl", nil) // reliable, ordered
	if err != nil {
		_ = pc.Close()
		return
	}
	ctrl.OnMessage(func(msg webrtc.DataChannelMessage) { handleControl(msg.Data) })

	pc.OnICECandidate(func(cnd *webrtc.ICECandidate) {
		if cnd == nil {
			return
		}
		d, _ := json.Marshal(cnd.ToJSON())
		sendSig(sigMsg{Type: "ice", To: peer, Data: d})
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateConnected {
			s.markConnected()
		}
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.close()
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		_ = pc.Close()
		return
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		_ = pc.Close()
		return
	}
	d, _ := json.Marshal(offer)
	sendSig(sigMsg{Type: "offer", To: peer, Data: d})
	showBanner()
	log.Printf("session started with controller %s", peer)
}

func (s *session) onAnswer(data json.RawMessage) {
	var sd webrtc.SessionDescription
	if json.Unmarshal(data, &sd) != nil {
		return
	}
	if err := s.pc.SetRemoteDescription(sd); err != nil {
		log.Printf("set remote: %v", err)
		return
	}
	s.mu.Lock()
	s.remoteSet = true
	pending := s.pendingICE
	s.pendingICE = nil
	s.mu.Unlock()
	for _, c := range pending {
		_ = s.pc.AddICECandidate(c)
	}
}

func (s *session) onICE(data json.RawMessage) {
	var c webrtc.ICECandidateInit
	if json.Unmarshal(data, &c) != nil {
		return
	}
	s.mu.Lock()
	if !s.remoteSet {
		s.pendingICE = append(s.pendingICE, c)
		s.mu.Unlock()
		return
	}
	s.mu.Unlock()
	_ = s.pc.AddICECandidate(c)
}

func (s *session) captureLoop(dc *webrtc.DataChannel) {
	t := time.NewTicker(frameInterval)
	defer t.Stop()
	var frameID uint32
	for {
		select {
		case <-s.stop:
			return
		case <-t.C:
			if dc.BufferedAmount() > bufferedLimit {
				continue
			}
			img, err := CaptureScreen()
			if err != nil {
				continue
			}
			var buf bytes.Buffer
			if jpeg.Encode(&buf, img, &jpeg.Options{Quality: jpegQuality}) != nil {
				continue
			}
			frameID++
			sendFramed(dc, frameID, buf.Bytes())
		}
	}
}

func (s *session) close() {
	s.closeOnce.Do(func() {
		close(s.stop)
		_ = s.pc.Close()
		removeSession(s.peer)
		s.mu.Lock()
		was := s.connected
		s.connected = false
		s.mu.Unlock()
		if was {
			fmt.Printf("SESSIONS %d\n", atomic.AddInt32(&connectedSessions, -1))
		}
		if sessionCount() == 0 {
			hideBanner()
		}
		log.Printf("session with %s ended", s.peer)
	})
}

// ----- control injection ---------------------------------------------------

type ctrlEvent struct {
	T  string  `json:"t"`           // m=move, b=button, w=wheel, k=key, u=text
	X  float64 `json:"x,omitempty"`
	Y  float64 `json:"y,omitempty"`
	B  int     `json:"b,omitempty"` // button 0/1/2
	VK int     `json:"vk,omitempty"`
	D  bool    `json:"d,omitempty"` // down (for b/k)
	W  int     `json:"w,omitempty"` // wheel delta
	S  string  `json:"s,omitempty"` // text typed on a phone keyboard (any language, e.g. ą ę ż)
}

// maxTypedText caps one "u" message so a misbehaving controller cannot flood input.
const maxTypedText = 512

func handleControl(data []byte) {
	var e ctrlEvent
	if json.Unmarshal(data, &e) != nil {
		return
	}
	switch e.T {
	case "m":
		MoveMouse(e.X, e.Y)
	case "b":
		MouseButton(e.B, e.D)
	case "w":
		Wheel(e.W)
	case "k":
		Key(e.VK, e.D)
	case "u":
		if len(e.S) > 0 && len(e.S) <= maxTypedText {
			TypeText(e.S)
		}
	}
}

// ----- framed video over the data channel ----------------------------------

func sendFramed(dc *webrtc.DataChannel, frameID uint32, data []byte) {
	total := (len(data) + chunkPayload - 1) / chunkPayload
	if total == 0 {
		total = 1
	}
	if total > 65535 {
		return
	}
	for i := 0; i < total; i++ {
		start := i * chunkPayload
		end := start + chunkPayload
		if end > len(data) {
			end = len(data)
		}
		msg := make([]byte, frameHeader+(end-start))
		binary.BigEndian.PutUint32(msg[0:4], frameID)
		binary.BigEndian.PutUint16(msg[4:6], uint16(i))
		binary.BigEndian.PutUint16(msg[6:8], uint16(total))
		copy(msg[frameHeader:], data[start:end])
		if dc.Send(msg) != nil {
			return
		}
	}
}

// ----- signaling + session registry ----------------------------------------

func sendSig(m sigMsg) {
	b, _ := json.Marshal(m)
	wsMu.Lock()
	defer wsMu.Unlock()
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	_ = conn.WriteMessage(websocket.TextMessage, b)
}

func addSession(peer string, s *session) {
	sessMu.Lock()
	sessions[peer] = s
	sessMu.Unlock()
}
func getSession(peer string) *session {
	sessMu.Lock()
	defer sessMu.Unlock()
	return sessions[peer]
}
func removeSession(peer string) {
	sessMu.Lock()
	delete(sessions, peer)
	sessMu.Unlock()
}
func sessionCount() int {
	sessMu.Lock()
	defer sessMu.Unlock()
	return len(sessions)
}

// ----- banner + helpers ----------------------------------------------------

func showBanner() {
	notify("LivePL Connect — SESJA AKTYWNA", "Ktos ma teraz podglad i kontrole nad tym ekranem.")
}
func hideBanner() {
	notify("LivePL Connect — sesja zakonczona", "Zdalny dostep zostal zakonczony.")
}
func notify(title, body string) {
	switch runtime.GOOS {
	case "windows":
		_ = exec.Command("msg", "*", "/TIME:10", title+" - "+body).Start()
	case "linux":
		_ = exec.Command("notify-send", "-u", "critical", title, body).Start()
	case "darwin":
		_ = exec.Command("osascript", "-e", "display notification \""+body+"\" with title \""+title+"\"").Start()
	}
}

func randDigits(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = byte('0' + int(b[i])%10)
	}
	return string(b)
}

func formatID(id string) string {
	if len(id) == 9 {
		return id[0:3] + " " + id[3:6] + " " + id[6:9]
	}
	return id
}
