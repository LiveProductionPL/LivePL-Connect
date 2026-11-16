package main

import (
	"encoding/hex"
	"os"
	"testing"
)

// Test vectors for PBKDF2-HMAC-SHA256 (RFC 7914 section 11 style, dkLen 32).
func TestPBKDF2SHA256(t *testing.T) {
	cases := []struct {
		iter int
		want string
	}{
		{1, "120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b"},
		{2, "ae4d0c95af6b46d32d0adff928f06dd02a303f8ef3c251dfd6e2d85a95474c43"},
		{4096, "c5e478d59288c841aa530db6845c4c8d962893a001ce4e11a4963873aa98134a"},
	}
	for _, c := range cases {
		got := hex.EncodeToString(pbkdf2SHA256([]byte("password"), []byte("salt"), c.iter))
		if got != c.want {
			t.Errorf("iter %d: got %s want %s", c.iter, got, c.want)
		}
	}
	// the desktop app hashes with Node: crypto.pbkdf2Sync('Stałe-hasło 2026', '0123456789abcdef', 20000, 32, 'sha256')
	node := "817f0c68f591aa5e2e24526aabaa1defd64c9e7d119450e0a7191ee06bd2f187"
	if got := hex.EncodeToString(pbkdf2SHA256([]byte("Stałe-hasło 2026"), []byte("0123456789abcdef"), 20000)); got != node {
		t.Errorf("Go and Node disagree: %s vs %s", got, node)
	}
}

func TestPasswords(t *testing.T) {
	myPass = "123456"
	salt := []byte("0123456789abcdef")
	hash := pbkdf2SHA256([]byte("Stałe-hasło 2026"), salt, 20000)
	os.Setenv("LPC_STALE_HASLO", "pbkdf2-sha256$20000$"+hex.EncodeToString(salt)+"$"+hex.EncodeToString(hash))
	loadPermanentPassword()
	if os.Getenv("LPC_STALE_HASLO") != "" {
		t.Error("hash should be removed from the environment")
	}
	for _, c := range []struct {
		pw string
		ok bool
	}{{"123456", true}, {"Stałe-hasło 2026", true}, {"stałe-hasło 2026", false}, {"", false}, {"12345", false}} {
		if passwordOK(c.pw) != c.ok {
			t.Errorf("passwordOK(%q) = %v, want %v", c.pw, !c.ok, c.ok)
		}
	}
	permanent = nil
}

func TestWrongTriesLimit(t *testing.T) {
	wrongTries = nil
	for i := 0; i < maxWrongTries; i++ {
		if tooManyWrongTries() {
			t.Fatalf("blocked too early after %d tries", i)
		}
		noteWrongTry()
	}
	if !tooManyWrongTries() {
		t.Fatal("should be blocked after maxWrongTries wrong passwords")
	}
	wrongTries = nil
}
