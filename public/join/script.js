// test for documentPictureInPicture API support
if (!window.documentPictureInPicture) {
  document.body.innerHTML =
    '<h1>Your browser does not support the documentPictureInPicture API. Try Chrome or Edge.</h1>'
  throw new Error('Document Picture-in-Picture API not supported.')
}

// ========== join/leave logic ==========
const nameInput = document.getElementById('nameInput')
const colorInput = document.getElementById('colorInput')
const joinButton = document.getElementById('joinButton')
const leaveButton = document.getElementById('leaveButton')
const failedOkButton = document.getElementById('failedOkButton')
const primaryUIWrap = document.getElementById('primaryUIWrap')
const joinedString = document.getElementById('joinedString')
const loadingString = document.getElementById('loadingString')
const roomCode = window.location.hash.slice(1)
// room codes are hex (8 chars for older hosts, 16 for current ones)
const ROOM_CODE_PATTERN = /^[0-9a-f]{8,32}$/i

window.addEventListener('hashchange', () => {
  location.reload()
})

joinButton.addEventListener('click', () => {
  if (!ROOM_CODE_PATTERN.test(roomCode)) {
    setUIFailed()
    return
  }
  joinRoom(nameInput.value.trim(), colorInput.value, roomCode, 1, 3)
})

leaveButton.addEventListener('click', () => {
  leaveRoom()
})

failedOkButton.addEventListener('click', () => {
  setUIJoin()
})

if (localStorage.uspwipNameInputValue) {
  nameInput.value = localStorage.uspwipNameInputValue
}

// we randomize the colours every load until the user specifically sets one
if (localStorage.uspwipColorInputValue) {
  colorInput.value = localStorage.uspwipColorInputValue
} else {
  colorInput.value = getVibrantColorHex()
}

updateJoinButtonState()
nameInput.addEventListener('input', () => {
  updateJoinButtonState()
  localStorage.uspwipNameInputValue = nameInput.value.trim()
})

colorInput.addEventListener('input', () => {
  localStorage.uspwipColorInputValue = colorInput.value
})

function updateJoinButtonState() {
  if (nameInput.value.trim()) {
    joinButton.disabled = false
  } else {
    joinButton.disabled = true
  }
}

function setUIJoin() {
  primaryUIWrap.dataset.activeScreen = 'join'
}

function setUILoading(str) {
  loadingString.textContent = str
  primaryUIWrap.dataset.activeScreen = 'loading'
}

function setUIJoined(str) {
  joinedString.textContent = str
  primaryUIWrap.dataset.activeScreen = 'joined'
}

function setUIFailed(str) {
  primaryUIWrap.dataset.activeScreen = 'failed'
}

// ========== PIP logic ==========

const pipContent = document.getElementById('pipContent')
const goodUser = document.getElementById('goodUser')
const badUser = document.getElementById('badUser')
const badWayland = document.getElementById('badWayland')
var pipWindow
var codeRequestedUnlock = false
var lockRequestPending = false
var lockLost = false // we released a lock the browser had already lost
var likelyWayland = false

var deltaX = 0
var deltaY = 0
var mousedown = false
var active = false
var flushTimer = null
var lastSentAt = 0
// how far the pointer has been moving per event lately (see acceptMovement)
var recentMove = 0
var lastMoveAt = 0

// at most 50 movement updates a second (the host drops guests that send
// more than 150 messages a second)
const MOVE_INTERVAL_MS = 20
// a single movement this big that's also far beyond the recent speed is bogus
const JUMP_MIN_PX = 250
const JUMP_FACTOR = 8

function isLocked() {
  return !!pipWindow && pipWindow.document?.pointerLockElement === goodUser
}

/**
 * Asks for the pointer lock. On Wayland the compositor only turns the lock on
 * while the cursor is still inside this window, so this runs as soon as the
 * button goes down: waiting for the click (button up) gave a fast-moving
 * cursor time to leave first, and the page then thought it had the mouse
 * while the cursor wandered off.
 */
function lockPointer() {
  if (lockRequestPending || !pipWindow || isLocked()) return
  lockRequestPending = true
  let request
  try {
    request = goodUser.requestPointerLock()
  } catch (err) {
    request = Promise.reject(err)
  }
  Promise.resolve(request)
    .catch(err => {
      // e.g. right after Esc, Chrome refuses for a moment: just click again
      console.warn('Pointer lock refused:', err?.message ?? err)
    })
    .finally(() => {
      lockRequestPending = false
    })
  focusTypeCapture()
}

/** releases the pointer lock (`lost`: the browser had already lost it) */
function releasePointer(lost = false) {
  if (!isLocked()) return
  codeRequestedUnlock = true
  lockLost = lost
  pipWindow.document.exitPointerLock()
}

/**
 * Whether a pointer movement is real. Chrome on Wayland can lose the pointer
 * lock without telling the page (the compositor ends it, e.g. when something
 * pops up under the hidden cursor). Its next movement is then one huge jump:
 * the gap between where Chrome thought the hidden cursor went and where it
 * really is. A hand speeds up over several events, so a lone jump far beyond
 * the recent speed is dropped. On Wayland it means the lock is gone, so the
 * page lets go of it too and says to click again (instead of claiming the
 * mouse is still locked while the cursor is free).
 */
function acceptMovement(dx, dy) {
  const now = performance.now()
  if (now - lastMoveAt > 100) recentMove = 0 // stopped moving: start over
  lastMoveAt = now
  const distance = Math.hypot(dx, dy)
  if (
    distance > JUMP_MIN_PX &&
    distance > JUMP_FACTOR * Math.max(recentMove, 15)
  ) {
    console.warn(`Ignored a ${Math.round(distance)}px pointer jump`)
    if (likelyWayland) releasePointer(true)
    return false
  }
  recentMove = recentMove * 0.6 + distance * 0.4
  return true
}

/** sends the movement gathered so far along with the button/lock state */
function sendPointerState() {
  clearTimeout(flushTimer)
  flushTimer = null
  lastSentAt = performance.now()
  sendMouseMove(deltaX, deltaY, mousedown, active)
  deltaX = 0
  deltaY = 0
}

function runOnLock() {
  goodUser.classList.add('locked')
  goodUser.textContent = 'Right click to unlock mouse'

  active = true
  mousedown = false
  recentMove = 0
  lastMoveAt = 0
  sendPointerState()
}

function runOnUnlock() {
  if (!codeRequestedUnlock && pipWindow?.document?.hasFocus()) {
    badUser.style.display = 'grid'
  }
  codeRequestedUnlock = false

  goodUser.classList.remove('locked')
  goodUser.textContent = lockLost
    ? 'Lost the mouse. Left click here to control pointer again'
    : 'Left click here to control pointer'
  lockLost = false

  active = false
  mousedown = false // its mouse up won't reach us anymore
  sendPointerState()
}

async function launchPIP() {
  pipWindow = await documentPictureInPicture.requestWindow({
    // width is a lil wide bcs otherwise, on linux, the "press esc.." message weirdly expands the window to show itself
    // height is a lil tall bcs that seems to mitigate some issues with pointer locking on kde
    width: 720 / 2,
    height: 480 / 2,
    disallowReturnToOpener: true,
    preferInitialWindowPlacement: true
  })

  // (Wayland doesn't tell apps where their windows are)
  likelyWayland =
    pipWindow.screenX === 0 &&
    pipWindow.screenY === 0 &&
    !!window.navigator?.platform?.includes('Linux')
  if (likelyWayland) {
    badWayland.style.display = 'grid'
  }

  pipWindow.onpagehide = e => {
    document.body.append(e.target.getElementById('pipContent'))
    badUser.style.display = 'none'
    badWayland.style.display = 'none'
    clearTimeout(flushTimer)
    flushTimer = null
    pipWindow = null
    resetTyping()
    leaveRoom() // redundant if leave was triggered by somethign other than closing the PIP
  }

  // whenever the PiP window has focus, keystrokes go to the (hidden) typing box
  pipWindow.onfocus = () => {
    windowFocused = true
    focusTypeCapture()
    updateTypePreview()
  }
  pipWindow.onblur = () => {
    windowFocused = false
    // the compositor ends the lock when this window loses focus; don't keep
    // acting as if we still had it
    releasePointer()
    updateTypePreview()
  }
  // A keystroke must never be lost: if focus ever slipped off the typing box,
  // move it back before the key is handled; the browser then delivers the
  // character to the box (capture phase runs before anything else).
  pipWindow.document.addEventListener(
    'keydown',
    () => {
      if (pipWindow?.document?.activeElement !== typeCapture) focusTypeCapture()
    },
    true
  )

  pipWindow.document.onpointerlockchange = () => {
    if (pipWindow?.document?.pointerLockElement === goodUser) {
      runOnLock()
    } else {
      runOnUnlock()
    }
  }

  pipWindow.document.onmousemove = e => {
    if (!isLocked() || !acceptMovement(e.movementX, e.movementY)) return
    deltaX += e.movementX
    deltaY += e.movementY
    if (flushTimer) return
    // send right away unless we just did; then once the interval is up
    const wait = MOVE_INTERVAL_MS - (performance.now() - lastSentAt)
    if (wait <= 0) {
      sendPointerState()
    } else {
      flushTimer = setTimeout(() => {
        flushTimer = null
        if (deltaX !== 0 || deltaY !== 0) sendPointerState()
      }, wait)
    }
  }

  pipWindow.document.onmouseup = e => {
    if (isLocked() && e.button === 0) {
      mousedown = false
      sendPointerState()
    }
  }

  pipWindow.document.onmousedown = e => {
    e.preventDefault() // keep keyboard focus on the typing box
    if (!isLocked()) {
      // (not when dismissing one of the messages on top)
      if (e.button === 0 && e.target === goodUser) lockPointer()
      return
    }
    if (e.button === 0) {
      mousedown = true
      sendPointerState()
      pinDraft() // clicking pins whatever you're typing where the pointer is
    }
  }

  goodUser.onclick = e => {
    e.preventDefault()
    e.stopPropagation()
    if (e.button === 0 && !isLocked()) {
      // normally already requested on mouse down; this retries if that failed
      // on kde plasma, if the browser is running under x11 and requests a lock when the x11 PIP window is over a wayland window, the browser sometimes reports a lock even though we don't have one; we don't really have a fix for this at the moment
      lockPointer()
    } else if (e.button === 2) {
      // right click only fires "onclick" when pointer is locked (Blink follows
      // every mouse up with a click then); tested in chrome & edge
      releasePointer()
    }
  }

  // prevent right click when pointer isn't locked
  pipContent.oncontextmenu = e => {
    e.preventDefault()
    e.stopPropagation()
  }

  badUser.onclick = e => {
    badUser.style.display = 'none'
    e.stopPropagation()
    e.preventDefault()
  }

  badWayland.onclick = e => {
    badWayland.style.display = 'none'
    e.stopPropagation()
    e.preventDefault()
  }

  codeRequestedUnlock = false
  lockRequestPending = false
  lockLost = false
  deltaX = 0
  deltaY = 0
  mousedown = false
  active = false
  flushTimer = null
  lastSentAt = 0
  recentMove = 0
  lastMoveAt = 0
  goodUser.classList.remove('locked')
  goodUser.textContent = 'Left click here to control pointer'
  resetTyping()
  pipWindow.document.body.append(pipContent)
  windowFocused = pipWindow.document.hasFocus()
  focusTypeCapture()
  updateTypePreview()
}

// ========== typing logic ==========
// While the PiP window has focus, what you type shows up next to your pointer
// on the host's screen. Once you stop typing it stays a while (longer for
// longer text) and fades; the host then sends host-draft-expired and the box
// here is cleared too. Clicking pins the text there as a note. Every update
// carries the whole text plus a sequence number, since PeerJS data channels
// don't guarantee ordering.

const typeCapture = document.getElementById('typeCapture')
const typePreview = document.getElementById('typePreview')
const DEFAULT_TYPING = {
  fadeMs: 1500,
  maxHoldMs: 10000,
  maxLength: 200,
  maxLines: 5
}
const BLOCKED_KEYS = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Tab'
])
var typing = null // set by host-introduction; null = host can't show typing
var textSeq = 0
var lastSentText = ''
var textSendTimer = null
var textClearTimer = null
var composing = false
var windowFocused = false
// when something you typed didn't fit, the preview says so for a moment
// (nothing is ever dropped silently)
var limitUntil = 0
var limitReason = ''
const LIMIT_NOTICE_MS = 2500

function configureTyping(config) {
  if (!config || typeof config !== 'object') {
    typing = null
  } else {
    const pick = (value, min, max, fallback) =>
      Number.isFinite(value) && value >= min && value <= max ? value : fallback
    typing = {
      fadeMs: pick(config.fadeMs, 0, 60000, DEFAULT_TYPING.fadeMs),
      maxHoldMs: pick(config.maxHoldMs, 0, 60000, DEFAULT_TYPING.maxHoldMs),
      maxLength: pick(config.maxLength, 1, 1000, DEFAULT_TYPING.maxLength),
      maxLines: pick(config.maxLines, 1, 50, DEFAULT_TYPING.maxLines)
    }
    typeCapture.maxLength = typing.maxLength
  }
  resetTyping()
}

function focusTypeCapture() {
  if (pipWindow && typing && pipWindow.document.activeElement !== typeCapture) {
    typeCapture.focus({ preventScroll: true })
  }
}

function keepCaretAtEnd() {
  const end = typeCapture.value.length
  if (
    !composing &&
    (typeCapture.selectionStart !== end || typeCapture.selectionEnd !== end)
  ) {
    typeCapture.setSelectionRange(end, end)
  }
}

function updateTypePreview() {
  typePreview.hidden = !typing
  if (!typing) return
  const text = typeCapture.value
  const atLimit = Date.now() < limitUntil
  typePreview.classList.toggle('empty', !text && !atLimit)
  typePreview.classList.toggle('limit', atLimit)
  if (!text && !atLimit) {
    typePreview.textContent = windowFocused
      ? 'Type to write next to your pointer, click to pin it'
      : 'Click this window to type'
    return
  }
  // nearly full: show how much room is left; over: say what didn't fit
  let prefix = ''
  if (atLimit) {
    prefix =
      limitReason === 'lines'
        ? `Max ${typing.maxLines} lines! `
        : `Full (${typing.maxLength} characters)! `
  } else if (text.length >= typing.maxLength * 0.8) {
    prefix = `${text.length}/${typing.maxLength}: `
  }
  // show the end of what you're typing (whole characters, not half an emoji)
  const room = 60 - prefix.length
  const chars = Array.from(text.replace(/\n/g, ' \u21b5 '))
  typePreview.textContent =
    prefix +
    (chars.length > room
      ? '\u2026' + chars.slice(-(room - 1)).join('')
      : chars.join(''))
}

function flagLimit(reason) {
  limitReason = reason
  limitUntil = Date.now() + LIMIT_NOTICE_MS
  updateTypePreview()
  setTimeout(updateTypePreview, LIMIT_NOTICE_MS + 50)
}

/** characters the box can still take (replacing a selection frees its room) */
function roomLeft() {
  const selected = typeCapture.selectionEnd - typeCapture.selectionStart
  return typing.maxLength - (typeCapture.value.length - selected)
}

function sendText() {
  clearTimeout(textSendTimer)
  textSendTimer = null
  const text = typeCapture.value
  if (text === lastSentText || !currentConn) return
  lastSentText = text
  currentConn.send({ type: 'client-text', content: { text, seq: ++textSeq } })
}

/** the host has faded out exactly what this box holds: start fresh */
function onDraftExpired(seq) {
  if (seq !== textSeq || typeCapture.value !== lastSentText || composing) return
  clearTimeout(textClearTimer)
  typeCapture.value = ''
  lastSentText = ''
  limitUntil = 0
  updateTypePreview()
}

/** fallback if the host never says the text is gone (it always should) */
function clearDraft() {
  if (composing) {
    textClearTimer = setTimeout(clearDraft, 500)
    return
  }
  typeCapture.value = ''
  limitUntil = 0
  updateTypePreview()
  sendText()
}

function pinDraft() {
  const text = typeCapture.value
  if (!typing || !text.trim() || !currentConn) return
  clearTimeout(textSendTimer)
  clearTimeout(textClearTimer)
  textSendTimer = null
  currentConn.send({ type: 'client-pin', content: { text, seq: ++textSeq } })
  typeCapture.value = ''
  lastSentText = ''
  limitUntil = 0
  updateTypePreview()
}

function resetTyping() {
  clearTimeout(textSendTimer)
  clearTimeout(textClearTimer)
  textSendTimer = null
  typeCapture.value = ''
  lastSentText = ''
  composing = false
  limitUntil = 0
  updateTypePreview()
}

typeCapture.addEventListener('input', () => {
  if (!typing) {
    typeCapture.value = ''
    return
  }
  const lines = typeCapture.value.split('\n')
  if (lines.length > typing.maxLines) {
    // (only a paste can get here; typing Enter is stopped in keydown)
    typeCapture.value = lines.slice(0, typing.maxLines).join('\n')
    flagLimit('lines')
  }
  keepCaretAtEnd()
  updateTypePreview()
  if (!textSendTimer) textSendTimer = setTimeout(sendText, 40)
  clearTimeout(textClearTimer)
  if (typeCapture.value) {
    textClearTimer = setTimeout(
      clearDraft,
      typing.maxHoldMs + typing.fadeMs + 3000
    )
  }
})

typeCapture.addEventListener('keydown', e => {
  if (e.isComposing) return
  // the caret always stays at the end: no moving it or selecting text
  if (
    BLOCKED_KEYS.has(e.key) ||
    ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a')
  ) {
    e.preventDefault()
  } else if (e.key === 'Escape') {
    // (while the pointer is locked, Escape is the browser's "release mouse")
    if (pipWindow?.document?.pointerLockElement !== goodUser) {
      e.preventDefault()
      clearTimeout(textClearTimer)
      clearDraft()
    }
  } else if (
    e.key === 'Enter' &&
    typeCapture.value.split('\n').length >= (typing?.maxLines ?? 1)
  ) {
    e.preventDefault()
    flagLimit('lines')
  }
})

// the box's maxlength silently ignores what doesn't fit: say so instead
typeCapture.addEventListener('beforeinput', e => {
  if (!typing || e.inputType === 'insertFromPaste') return
  if (!e.inputType.startsWith('insert')) return
  const incoming = e.inputType === 'insertLineBreak' ? '\n' : (e.data ?? '')
  if (incoming.length > roomLeft()) flagLimit('characters')
})
typeCapture.addEventListener('paste', e => {
  if (!typing) return
  const pasted = e.clipboardData?.getData('text') ?? ''
  if (pasted.length > roomLeft()) flagLimit('characters')
})

typeCapture.addEventListener('compositionstart', () => {
  composing = true
})
typeCapture.addEventListener('compositionend', () => {
  composing = false
  keepCaretAtEnd()
})
typeCapture.addEventListener('blur', () => {
  setTimeout(focusTypeCapture, 0)
})

// ========== comms logic ==========

const peer = new Peer() // clients can have random ids, we only care to shorten host uuids
var currentConn

peer.on('disconnected', () => {
  peer.reconnect()
})

function joinRoom(name, color, code, attemptNum, maxAttempts) {
  setUILoading(`Connecting${'.'.repeat(attemptNum)}`)

  // the desktop host only accepts JSON: PeerJS's default binary serializer
  // reassembles chunked messages without limits, which a peer could abuse
  currentConn = peer.connect('uspwip-fun-super-unique-id-' + code, {
    serialization: 'json'
  })
  const pingTimeout = setTimeout(() => {
    currentConn?.send({
      type: 'ping'
    })
  }, 1000)
  currentConn.on('open', () => {
    console.log('establed connection')
    currentConn.send({
      type: 'client-introduction',
      content: {
        name: name,
        color: color
      }
    })
  })
  let introduced = false
  currentConn.on('data', data => {
    if (data?.type === 'host-introduction' && !introduced) {
      introduced = true
      const hostName = String(data?.content?.name ?? '')
        .substring(0, 15)
        .trim()
      setUIJoined(`Connected to ${hostName} as ${name}`)
      configureTyping(data?.content?.typing) // absent = older host
      launchPIP()
    } else if (data?.type === 'host-draft-expired') {
      onDraftExpired(data?.content?.seq)
    }
  })
  currentConn.on('error', () => {
    currentConn?.close()
    currentConn = null
    if (attemptNum < maxAttempts) {
      joinRoom(name, color, code, attemptNum + 1, maxAttempts)
    } else {
      setUIFailed()
      clearTimeout(pingTimeout)
    }
  })
  currentConn.on('close', () => {
    // seems currentConn.close() doesn't fire this (which is good)
    pipWindow?.close()
    setUIJoin()
    currentConn = null
    clearTimeout(pingTimeout)
  })
}

function leaveRoom() {
  currentConn?.close()
}

function sendMouseMove(x, y, mousedown, active) {
  if (currentConn) {
    currentConn.send({
      type: 'client-mousemove',
      content: {
        x: x,
        y: y,
        mousedown: mousedown,
        active: active
      }
    })
  }
}

// ========== helpers ==========

function getBrightColorHex() {
  // RGB values between 160 and 220
  const r = Math.floor(Math.random() * 60 + 160)
  const g = Math.floor(Math.random() * 60 + 160)
  const b = Math.floor(Math.random() * 60 + 160)

  const toHex = c => c.toString(16).padStart(2, '0')

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`
}

function getVibrantColorHex() {
  const channels = [
    Math.floor(Math.random() * 60 + 160), // high-ish
    Math.floor(Math.random() * 60 + 100), // medium
    Math.floor(Math.random() * 60 + 40) // low
  ]

  // Shuffle the channels
  for (let i = channels.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[channels[i], channels[j]] = [channels[j], channels[i]]
  }

  const toHex = c => c.toString(16).padStart(2, '0')
  return `#${channels.map(toHex).join('')}`
}
