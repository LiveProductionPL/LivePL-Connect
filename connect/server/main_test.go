package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// peer is a test client. A peer that stops reading also stops answering pings,
// which is how a half-open (stale) connection looks to the server.
type peer struct {
	t  *testing.T
	ws *websocket.Conn
	in chan Msg
}

func dial(t *testing.T, url string) *peer {
	ws, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	p := &peer{t: t, ws: ws, in: make(chan Msg, 16)}
	t.Cleanup(func() { ws.Close() })
	return p
}

func (p *peer) read() {
	go func() {
		for {
			_, b, err := p.ws.ReadMessage()
			if err != nil {
				close(p.in)
				return
			}
			var m Msg
			_ = json.Unmarshal(b, &m)
			p.in <- m
		}
	}()
}

func (p *peer) register(id, key string) {
	b, _ := json.Marshal(Msg{Type: "register", ID: id, Key: key})
	if err := p.ws.WriteMessage(websocket.TextMessage, b); err != nil {
		p.t.Fatal(err)
	}
}

func (p *peer) expect(typ string) Msg {
	p.t.Helper()
	select {
	case m, ok := <-p.in:
		if !ok {
			p.t.Fatalf("connection closed, wanted %q", typ)
		}
		if m.Type != typ {
			p.t.Fatalf("got %q, wanted %q", m.Type, typ)
		}
		return m
	case <-time.After(3 * time.Second):
		p.t.Fatalf("timeout waiting for %q", typ)
	}
	return Msg{}
}

func start(t *testing.T) (string, func()) {
	mu.Lock()
	clients = map[string]*client{}
	hosts = map[string]string{}
	owners = map[string]owner{}
	ownersDirty = false
	newByIP = map[string]int{}
	ownersFile = filepath.Join(t.TempDir(), "dane", "id.json")
	mu.Unlock()
	probeWait = 300 * time.Millisecond
	srv := httptest.NewServer(http.HandlerFunc(serveWS))
	url := "ws" + strings.TrimPrefix(srv.URL, "http") + "/ws"
	return url, srv.Close
}

const keyA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const keyB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func TestOwnedIDSurvivesStaleConnection(t *testing.T) {
	url, stop := start(t)
	defer stop()
	h1 := dial(t, url)
	h1.read()
	h1.register("", keyA)
	id := h1.expect("registered").ID

	// stale link: h1 stays connected on the server but no longer reads or answers
	h2 := dial(t, url)
	h2.read()
	h2.register(id, keyA)
	if got := h2.expect("registered").ID; got != id {
		t.Fatalf("owner reconnected and got %s instead of %s", got, id)
	}
	if h1.expect("replaced").Type != "replaced" {
		t.Fatal("old link not told")
	}
}

func TestOwnedIDRefusedWithoutKey(t *testing.T) {
	url, stop := start(t)
	defer stop()
	h1 := dial(t, url)
	h1.read()
	h1.register("", keyA)
	id := h1.expect("registered").ID
	h1.ws.Close()
	time.Sleep(100 * time.Millisecond) // server notices the close; the ID is free but still owned

	for _, key := range []string{"", keyB, "short"} {
		x := dial(t, url)
		x.read()
		x.register(id, key)
		if got := x.expect("registered").ID; got == id {
			t.Fatalf("owned ID %s given to a peer with key %q", id, key)
		}
		x.ws.Close()
	}
	back := dial(t, url)
	back.read()
	back.register(id, keyA)
	if got := back.expect("registered").ID; got != id {
		t.Fatalf("owner came back and got %s instead of %s", got, id)
	}
}

func TestOwnersPersistAcrossRestart(t *testing.T) {
	url, stop := start(t)
	h1 := dial(t, url)
	h1.read()
	h1.register("", keyA)
	id := h1.expect("registered").ID
	saveOwners()
	stop()

	b, err := os.ReadFile(ownersFile)
	if err != nil || !strings.Contains(string(b), id) || strings.Contains(string(b), keyA) {
		t.Fatalf("owners file should hold the ID and only a hash of the key: %s %v", b, err)
	}
	mu.Lock()
	owners = map[string]owner{}
	mu.Unlock()
	loadOwners()
	if _, ok := owners[id]; !ok {
		t.Fatal("owner not loaded back")
	}
}

func TestLegacyIDTakenFromSilentHolderOnly(t *testing.T) {
	url, stop := start(t)
	defer stop()
	// hosts before 0.6.1 send no key
	live := dial(t, url)
	live.read()
	live.register("", "")
	id := live.expect("registered").ID

	other := dial(t, url)
	other.read()
	other.register(id, "")
	if got := other.expect("registered").ID; got == id {
		t.Fatal("ID taken from a holder that still answers")
	}

	silent := dial(t, url)
	silent.read()
	silent.register("", "")
	id2 := silent.expect("registered").ID
	// stop reading: pings go unanswered, like a link that died after a network change
	silent.ws.SetReadDeadline(time.Now())
	time.Sleep(50 * time.Millisecond)

	again := dial(t, url)
	again.read()
	again.register(id2, "")
	if got := again.expect("registered").ID; got != id2 {
		t.Fatalf("legacy host lost its ID to a stale link: got %s, wanted %s", got, id2)
	}
}

func TestNewIDsSkipOwnedOnes(t *testing.T) {
	url, stop := start(t)
	defer stop()
	h := dial(t, url)
	h.read()
	h.register("", keyA)
	id := h.expect("registered").ID
	mu.RLock()
	_, owned := owners[id]
	mu.RUnlock()
	if !owned {
		t.Fatal("new ID with a key is not recorded")
	}
}
