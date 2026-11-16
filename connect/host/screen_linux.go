//go:build linux

package main

import (
	"errors"
	"image"

	"github.com/kbinani/screenshot"
)

// CaptureScreen grabs the primary display via X11 (needs a desktop session).
func CaptureScreen() (image.Image, error) {
	if screenshot.NumActiveDisplays() <= 0 {
		return nil, errors.New("no active display (headless?)")
	}
	return screenshot.CaptureRect(screenshot.GetDisplayBounds(0))
}
