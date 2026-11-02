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
    leaveRoom() // redundant if leave was triggered by somethign other than closing the PIP
  }

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
    if (
      pipWindow?.document?.pointerLockElement === goodUser &&
      e.button === 0
    ) {
      mousedown = true
      sendMouseMove(deltaX, deltaY, mousedown, active)
      deltaX = 0
      deltaY = 0
    }
  }

  goodUser.onclick = async e => {
    if (e.button == 0 && pipWindow?.document?.pointerLockElement !== goodUser) {
      // on kde plasma, if the browser is running under x11 and requests a lock when the x11 PIP window is over a wayland window, the browser sometimes reports a lock even though we don't have one; we don't really have a fix for this at the moment
      await goodUser.requestPointerLock()
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
  pipWindow.document.body.append(pipContent)
}

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
