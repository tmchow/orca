// Why: E2EE primitives for the mobile side. Uses tweetnacl for Curve25519 ECDH
// key exchange and XSalsa20-Poly1305 authenticated encryption. Wire format is
// base64([24-byte nonce][ciphertext]) over WebSocket text frames.
import nacl from 'tweetnacl'
import * as ExpoCrypto from 'expo-crypto'

// Why: Hermes (React Native's JS engine) lacks crypto.getRandomValues,
// which tweetnacl requires. expo-crypto provides a native secure RNG
// that works in Expo Go without a custom dev build.
nacl.setPRNG((_x: Uint8Array, n: number) => {
  const bytes = ExpoCrypto.getRandomBytes(n)
  _x.set(bytes)
})

export function generateKeyPair(): nacl.BoxKeyPair {
  return nacl.box.keyPair()
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  return nacl.box.before(peerPublicKey, ourSecretKey)
}

// Why: React Native doesn't have Node's Buffer. Use atob/btoa which are
// available in the Hermes JS engine.
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!)
  }
  return btoa(binary)
}

function base64ToUint8(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function publicKeyFromBase64(b64: string): Uint8Array {
  return base64ToUint8(b64)
}

export function publicKeyToBase64(key: Uint8Array): string {
  return uint8ToBase64(key)
}

export function encrypt(plaintext: string, sharedKey: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength)
  const messageBytes = new TextEncoder().encode(plaintext)
  const ciphertext = nacl.box.after(messageBytes, nonce, sharedKey)

  const bundle = new Uint8Array(nonce.length + ciphertext.length)
  bundle.set(nonce)
  bundle.set(ciphertext, nonce.length)

  return uint8ToBase64(bundle)
}

export function decrypt(encrypted: string, sharedKey: Uint8Array): string | null {
  const bundle = base64ToUint8(encrypted)
  if (bundle.length < nacl.box.nonceLength + nacl.box.overheadLength) {
    return null
  }

  const nonce = new Uint8Array(bundle.subarray(0, nacl.box.nonceLength))
  const ciphertext = new Uint8Array(bundle.subarray(nacl.box.nonceLength))
  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedKey)

  if (!plaintext) {
    return null
  }

  return new TextDecoder().decode(plaintext)
}
