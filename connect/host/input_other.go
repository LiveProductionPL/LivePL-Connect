//go:build !windows

package main

// Input injection is implemented for Windows first (SendInput). On other
// platforms these are no-ops so the host still builds and can stream the screen
// (view-only); control arrives but is ignored.
func MoveMouse(fx, fy float64)     {}
func MouseButton(button int, down bool) {}
func Wheel(delta int)              {}
func Key(vk int, down bool)        {}
func TypeText(s string)            {}
