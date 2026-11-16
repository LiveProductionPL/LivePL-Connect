package main

// Passwords: the random session password shown in the app, plus an optional
// permanent password for unattended access. The desktop app never hands us the
// permanent password itself, only its PBKDF2-HMAC-SHA256 hash, through the
// LPC_STALE_HASLO environment variable ("pbkdf2-sha256$<iter>$<salt hex>$<hash hex>").
//
// Wrong guesses are rate limited for both passwords: after maxWrongTries wrong
// passwords within wrongWindow every attempt is refused until the window passes.

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"log"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	maxWrongTries = 8
	wrongWindow   = 10 * time.Minute
)

type permanentPassword struct {
	iter int
	salt []byte
	hash []byte
}

var (
	permanent *permanentPassword

	wrongMu    sync.Mutex
	wrongTries []time.Time
)

// loadPermanentPassword reads (and removes from our environment, so child
// processes never see it) the permanent password hash set by the desktop app.
func loadPermanentPassword() {
	v := os.Getenv("LPC_STALE_HASLO")
	_ = os.Unsetenv("LPC_STALE_HASLO")
	if v == "" {
		return
	}
	p := strings.Split(v, "$")
	if len(p) != 4 || p[0] != "pbkdf2-sha256" {
		log.Printf("permanent password: unknown format, ignored")
		return
	}
	iter, err := strconv.Atoi(p[1])
	salt, err2 := hex.DecodeString(p[2])
	hash, err3 := hex.DecodeString(p[3])
	if err != nil || err2 != nil || err3 != nil || iter < 10000 || iter > 5000000 || len(salt) < 8 || len(hash) != 32 {
		log.Printf("permanent password: invalid parameters, ignored")
		return
	}
	permanent = &permanentPassword{iter: iter, salt: salt, hash: hash}
	log.Printf("permanent password: enabled (unattended access)")
}

// pbkdf2SHA256 derives one 32-byte block, identical to Node's
// crypto.pbkdf2Sync(password, salt, iter, 32, 'sha256').
func pbkdf2SHA256(password, salt []byte, iter int) []byte {
	mac := hmac.New(sha256.New, password)
	mac.Write(salt)
	mac.Write([]byte{0, 0, 0, 1})
	u := mac.Sum(nil)
	t := append([]byte(nil), u...)
	for i := 1; i < iter; i++ {
		mac.Reset()
		mac.Write(u)
		u = mac.Sum(u[:0])
		for j := range t {
			t[j] ^= u[j]
		}
	}
	return t
}

// passwordOK accepts the session password or the permanent one (constant time).
func passwordOK(given string) bool {
	if given == "" {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(given), []byte(myPass)) == 1 {
		return true
	}
	if permanent != nil && len(given) <= 128 {
		return subtle.ConstantTimeCompare(pbkdf2SHA256([]byte(given), permanent.salt, permanent.iter), permanent.hash) == 1
	}
	return false
}

func pruneWrongTries(now time.Time) {
	keep := wrongTries[:0]
	for _, t := range wrongTries {
		if now.Sub(t) < wrongWindow {
			keep = append(keep, t)
		}
	}
	wrongTries = keep
}

// tooManyWrongTries reports whether password checks are paused right now.
func tooManyWrongTries() bool {
	wrongMu.Lock()
	defer wrongMu.Unlock()
	pruneWrongTries(time.Now())
	return len(wrongTries) >= maxWrongTries
}

func noteWrongTry() {
	wrongMu.Lock()
	defer wrongMu.Unlock()
	now := time.Now()
	pruneWrongTries(now)
	wrongTries = append(wrongTries, now)
}
