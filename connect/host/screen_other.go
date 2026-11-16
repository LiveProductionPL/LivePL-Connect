//go:build !windows && !linux

package main

import (
	"errors"
	"image"
)

func CaptureScreen() (image.Image, error) {
	return nil, errors.New("screen capture not supported on this platform build")
}
