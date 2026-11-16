//go:build windows

package main

import (
	"errors"
	"image"

	"github.com/kbinani/screenshot"
)

// CaptureScreen grabs the primary display (pure Go on Windows).
func CaptureScreen() (image.Image, error) {
	if screenshot.NumActiveDisplays() <= 0 {
		return nil, errors.New("no active display")
	}
	return screenshot.CaptureRect(screenshot.GetDisplayBounds(0))
}
