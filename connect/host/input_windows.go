//go:build windows

package main

import (
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Remote input injection via the Win32 SendInput API. Coordinates from the
// controller are normalized (0..1) over the virtual desktop.

var (
	user32           = windows.NewLazySystemDLL("user32.dll")
	procSendInput    = user32.NewProc("SendInput")
	procGetSystemMet = user32.NewProc("GetSystemMetrics")
	procMapVirtualKey = user32.NewProc("MapVirtualKeyW")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseeventfMove        = 0x0001
	mouseeventfLeftDown    = 0x0002
	mouseeventfLeftUp      = 0x0004
	mouseeventfRightDown   = 0x0008
	mouseeventfRightUp     = 0x0010
	mouseeventfMiddleDown  = 0x0020
	mouseeventfMiddleUp    = 0x0040
	mouseeventfWheel       = 0x0800
	mouseeventfAbsolute    = 0x8000
	mouseeventfVirtualDesk = 0x4000

	keyeventfExtendedKey = 0x0001
	keyeventfKeyup       = 0x0002
	keyeventfUnicode     = 0x0004

	mapvkVkToVsc = 0

	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCXVirtualScreen = 78
	smCYVirtualScreen = 79
)

// INPUT on amd64: Type(4) + padding(4) + union(32 bytes, MOUSEINPUT is largest).
type rawInput struct {
	inputType uint32
	_         uint32
	data      [32]byte
}

type mouseInput struct {
	dx          int32
	dy          int32
	mouseData   uint32
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

type keybdInput struct {
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	dwExtraInfo uintptr
}

func getMetric(i int32) int32 {
	r, _, _ := procGetSystemMet.Call(uintptr(i))
	return int32(r)
}

func sendInputs(in *rawInput) {
	_, _, _ = procSendInput.Call(1, uintptr(unsafe.Pointer(in)), unsafe.Sizeof(*in))
}

// MoveMouse moves the cursor to a normalized (fx, fy) position on the virtual desktop.
func MoveMouse(fx, fy float64) {
	vx, vy := getMetric(smXVirtualScreen), getMetric(smYVirtualScreen)
	vw, vh := getMetric(smCXVirtualScreen), getMetric(smCYVirtualScreen)
	if vw <= 0 || vh <= 0 {
		return
	}
	absX := int32(float64(vx)+fx*float64(vw)) * 65535 / vw
	absY := int32(float64(vy)+fy*float64(vh)) * 65535 / vh
	mi := mouseInput{dx: absX, dy: absY, dwFlags: mouseeventfMove | mouseeventfAbsolute | mouseeventfVirtualDesk}
	var in rawInput
	in.inputType = inputMouse
	*(*mouseInput)(unsafe.Pointer(&in.data)) = mi
	sendInputs(&in)
}

// MouseButton presses or releases a button (0=left, 1=right, 2=middle).
func MouseButton(button int, down bool) {
	var flag uint32
	switch button {
	case 1:
		flag = mouseeventfRightDown
		if !down {
			flag = mouseeventfRightUp
		}
	case 2:
		flag = mouseeventfMiddleDown
		if !down {
			flag = mouseeventfMiddleUp
		}
	default:
		flag = mouseeventfLeftDown
		if !down {
			flag = mouseeventfLeftUp
		}
	}
	mi := mouseInput{dwFlags: flag}
	var in rawInput
	in.inputType = inputMouse
	*(*mouseInput)(unsafe.Pointer(&in.data)) = mi
	sendInputs(&in)
}

// Wheel scrolls vertically (positive = up).
func Wheel(delta int) {
	mi := mouseInput{mouseData: uint32(int32(delta)), dwFlags: mouseeventfWheel}
	var in rawInput
	in.inputType = inputMouse
	*(*mouseInput)(unsafe.Pointer(&in.data)) = mi
	sendInputs(&in)
}

// Key presses or releases a Windows virtual-key code.
func Key(vk int, down bool) {
	if vk <= 0 || vk > 0xFE {
		return
	}
	r, _, _ := procMapVirtualKey.Call(uintptr(vk), mapvkVkToVsc)
	ki := keybdInput{wVk: uint16(vk), wScan: uint16(r)}
	if extendedKey(vk) {
		ki.dwFlags |= keyeventfExtendedKey
	}
	if !down {
		ki.dwFlags |= keyeventfKeyup
	}
	var in rawInput
	in.inputType = inputKeyboard
	*(*keybdInput)(unsafe.Pointer(&in.data)) = ki
	sendInputs(&in)
}

// extendedKey reports keys that Windows expects with KEYEVENTF_EXTENDEDKEY
// (otherwise arrows, Home/End, Delete etc. may arrive as their numpad twins).
func extendedKey(vk int) bool {
	switch {
	case vk >= 0x21 && vk <= 0x28: // PgUp, PgDn, End, Home, arrows
		return true
	case vk == 0x2D || vk == 0x2E: // Insert, Delete
		return true
	case vk == 0x5B || vk == 0x5C || vk == 0x5D: // Win, Win, Menu
		return true
	case vk == 0xA3 || vk == 0xA5: // right Ctrl, right Alt
		return true
	case vk == 0x6F || vk == 0x90: // numpad divide, Num Lock
		return true
	}
	return false
}

// TypeText types arbitrary text as Unicode key events, independent of the
// host's keyboard layout (needed for phone keyboards and Polish letters).
func TypeText(s string) {
	for _, u := range utf16.Encode([]rune(s)) {
		if u == '\r' {
			continue
		}
		if u == '\n' {
			Key(0x0D, true)
			Key(0x0D, false)
			continue
		}
		for _, up := range []bool{false, true} {
			ki := keybdInput{wScan: u, dwFlags: keyeventfUnicode}
			if up {
				ki.dwFlags |= keyeventfKeyup
			}
			var in rawInput
			in.inputType = inputKeyboard
			*(*keybdInput)(unsafe.Pointer(&in.data)) = ki
			sendInputs(&in)
		}
	}
}
