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

var deltaX = 0
var deltaY = 0
var mousedown = false
var active = false
var flushTimer = null

function runOnLock() {
  goodUser.classList.add('locked')
  goodUser.textContent = 'Right click to unlock mouse'

  active = true
  mousedown = false
  sendMouseMove(deltaX, deltaY, mousedown, active)
  deltaX = 0
  deltaY = 0
}

function runOnUnlock() {
  if (!codeRequestedUnlock && pipWindow?.document?.hasFocus()) {
    badUser.style.display = 'grid'
  }
  codeRequestedUnlock = false

  goodUser.classList.remove('locked')
  goodUser.textContent = 'Left click here to control pointer'

  active = false
  sendMouseMove(deltaX, deltaY, mousedown, active)
  deltaX = 0
  deltaY = 0
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

  if (
    pipWindow.screenX === 0 &&
    pipWindow.screenY === 0 &&
    window.navigator?.platform?.includes('Linux')
  ) {
    badWayland.style.display = 'grid'
  }

  pipWindow.onpagehide = e => {
    document.body.append(e.target.getElementById('pipContent'))
    badUser.style.display = 'none'
    badWayland.style.display = 'none'
    pipWindow = null
    resetTyping()
    leaveRoom() // redundant if leave was triggered by somethign other than closing the PIP
  }

  // whenever the PiP window has focus, keystrokes go to the (hidden) typing box
  pipWindow.onfocus = focusTypeCapture

  pipWindow.document.onpointerlockchange = () => {
    if (pipWindow?.document?.pointerLockElement === goodUser) {
      runOnLock()
    } else {
      runOnUnlock()
    }
  }

  pipWindow.document.onmousemove = e => {
    if (pipWindow?.document?.pointerLockElement === goodUser) {
      deltaX += e.movementX
      deltaY += e.movementY
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null
          if (deltaX + deltaY == 0) return
          sendMouseMove(deltaX, deltaY, mousedown, active)
          deltaX = 0
          deltaY = 0
        }, 20)
      }
    }
  }

  pipWindow.document.onmouseup = e => {
    if (
      pipWindow?.document?.pointerLockElement === goodUser &&
      e.button === 0
    ) {
      mousedown = false
      sendMouseMove(deltaX, deltaY, mousedown, active)
      deltaX = 0
      deltaY = 0
    }
  }

  pipWindow.document.onmousedown = e => {
    e.preventDefault() // keep keyboard focus on the typing box
    if (
      pipWindow?.document?.pointerLockElement === goodUser &&
      e.button === 0
    ) {
      mousedown = true
      sendMouseMove(deltaX, deltaY, mousedown, active)
      deltaX = 0
      deltaY = 0
      pinDraft() // clicking pins whatever you're typing where the pointer is
    }
  }

  goodUser.onclick = async e => {
    if (e.button == 0 && pipWindow?.document?.pointerLockElement !== goodUser) {
      // on kde plasma, if the browser is running under x11 and requests a lock when the x11 PIP window is over a wayland window, the browser sometimes reports a lock even though we don't have one; we don't really have a fix for this at the moment
      await goodUser.requestPointerLock()
      focusTypeCapture()
    } else if (e.button == 2 && pipWindow) {
      // right click only fires "onclick" when pointer is locked; tested in chrome & edge
      codeRequestedUnlock = true
      pipWindow.document.exitPointerLock()
    }

    e.preventDefault()
    e.stopPropagation()
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
  deltaX = 0
  deltaY = 0
  mousedown = false
  active = false
  flushTimer = null
  resetTyping()
  pipWindow.document.body.append(pipContent)
  focusTypeCapture()
}

// ========== typing logic ==========
// While the PiP window has focus, what you type shows up next to your pointer
// on the host's screen. It fades once you stop typing; clicking pins it there
// as a note. Every update carries the whole text plus a sequence number, since
// PeerJS data channels don't guarantee ordering.

const typeCapture = document.getElementById('typeCapture')
const typePreview = document.getElementById('typePreview')
const DEFAULT_TYPING = {
  idleMs: 2500,
  fadeMs: 1500,
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

function configureTyping(config) {
  if (!config || typeof config !== 'object') {
    typing = null
  } else {
    const pick = (value, min, max, fallback) =>
      Number.isFinite(value) && value >= min && value <= max ? value : fallback
    typing = {
      idleMs: pick(config.idleMs, 200, 60000, DEFAULT_TYPING.idleMs),
      fadeMs: pick(config.fadeMs, 0, 60000, DEFAULT_TYPING.fadeMs),
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
  const text = typeCapture.value
  typePreview.classList.toggle('empty', !text)
  if (!text) {
    typePreview.textContent =
      'Type to write next to your pointer, click to pin it'
    return
  }
  // show the end of what you're typing (whole characters, not half an emoji)
  const chars = Array.from(text.replace(/\n/g, ' \u21b5 '))
  typePreview.textContent =
    chars.length > 60 ? '\u2026' + chars.slice(-59).join('') : chars.join('')
}

function sendText() {
  clearTimeout(textSendTimer)
  textSendTimer = null
  const text = typeCapture.value
  if (text === lastSentText || !currentConn) return
  lastSentText = text
  currentConn.send({ type: 'client-text', content: { text, seq: ++textSeq } })
}

/** once you stop typing the host fades the text out; forget it at the same time */
function clearDraft() {
  if (composing) {
    textClearTimer = setTimeout(clearDraft, 500)
    return
  }
  typeCapture.value = ''
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
  updateTypePreview()
}

function resetTyping() {
  clearTimeout(textSendTimer)
  clearTimeout(textClearTimer)
  textSendTimer = null
  typeCapture.value = ''
  lastSentText = ''
  composing = false
  updateTypePreview()
}

typeCapture.addEventListener('input', () => {
  if (!typing) {
    typeCapture.value = ''
    return
  }
  const lines = typeCapture.value.split('\n')
  if (lines.length > typing.maxLines) {
    typeCapture.value = lines.slice(0, typing.maxLines).join('\n')
  }
  keepCaretAtEnd()
  updateTypePreview()
  if (!textSendTimer) textSendTimer = setTimeout(sendText, 40)
  clearTimeout(textClearTimer)
  if (typeCapture.value) {
    textClearTimer = setTimeout(clearDraft, typing.idleMs + typing.fadeMs)
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
  }
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
