// Why: the WebSocket transport uses wss:// with a self-signed TLS certificate
// to prevent passive sniffing of device tokens on shared WiFi networks. The
// cert is generated once on first run and reused across restarts. The mobile
// app pins the certificate fingerprint received during QR pairing.
import { createHash, generateKeyPairSync, createSign, randomBytes } from 'crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'

const TLS_CERT_FILENAME = 'orca-tls-cert.pem'
const TLS_KEY_FILENAME = 'orca-tls-key.pem'

export type TlsCertificate = {
  cert: string
  key: string
  fingerprint: string
}

export function loadOrCreateTlsCertificate(userDataPath: string): TlsCertificate {
  const certPath = join(userDataPath, TLS_CERT_FILENAME)
  const keyPath = join(userDataPath, TLS_KEY_FILENAME)

  if (existsSync(certPath) && existsSync(keyPath)) {
    const cert = readFileSync(certPath, 'utf-8')
    const key = readFileSync(keyPath, 'utf-8')
    return { cert, key, fingerprint: computeFingerprint(cert) }
  }

  const { cert, key } = generateSelfSignedCert()

  writeFileSync(keyPath, key, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  writeFileSync(certPath, cert, { mode: 0o600 })
  chmodSync(certPath, 0o600)

  return { cert, key, fingerprint: computeFingerprint(cert) }
}

function computeFingerprint(certPem: string): string {
  const derMatch = certPem.match(
    /-----BEGIN CERTIFICATE-----\n([\s\S]+?)\n-----END CERTIFICATE-----/
  )
  if (!derMatch?.[1]) {
    throw new Error('Invalid PEM certificate')
  }
  const der = Buffer.from(derMatch[1].replace(/\n/g, ''), 'base64')
  const hash = createHash('sha256').update(der).digest('hex')
  return `sha256:${hash}`
}

// Why: we generate a minimal self-signed X.509v1 certificate using only
// Node.js built-in crypto. This avoids a dependency on `selfsigned` or
// OpenSSL CLI and keeps the cert generation auditable in one place.
function generateSelfSignedCert(): { cert: string; key: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1'
  })

  const keyPem = privateKey.export({ type: 'sec1', format: 'pem' }) as string
  const pubDer = publicKey.export({ type: 'spki', format: 'der' })

  const serialNumber = randomBytes(16)
  serialNumber[0]! &= 0x7f

  const now = new Date()
  const notBefore = formatAsn1Time(now)
  // Why: 10 years validity — the cert is self-signed and pinned by fingerprint,
  // not trusted via a CA chain, so long validity is fine.
  const notAfter = formatAsn1Time(new Date(now.getFullYear() + 10, now.getMonth(), now.getDate()))

  const issuerAndSubject = encodeDistinguishedName('Orca Runtime')

  const tbs = encodeTbsCertificate({
    serialNumber,
    issuer: issuerAndSubject,
    notBefore,
    notAfter,
    subject: issuerAndSubject,
    subjectPublicKeyInfo: pubDer
  })

  const signer = createSign('SHA256')
  signer.update(tbs)
  const signature = signer.sign(privateKey)

  const cert = encodeX509Certificate(tbs, signature)
  const certPem = `-----BEGIN CERTIFICATE-----\n${cert
    .toString('base64')
    .match(/.{1,64}/g)!
    .join('\n')}\n-----END CERTIFICATE-----\n`

  return { cert: certPem, key: keyPem }
}

function formatAsn1Time(date: Date): string {
  const y = date.getUTCFullYear().toString().slice(2)
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0')
  const d = date.getUTCDate().toString().padStart(2, '0')
  return `${y}${m}${d}000000Z`
}

function encodeAsn1Length(length: number): Buffer {
  if (length < 0x80) {
    return Buffer.from([length])
  }
  if (length < 0x100) {
    return Buffer.from([0x81, length])
  }
  return Buffer.from([0x82, (length >> 8) & 0xff, length & 0xff])
}

function encodeAsn1Sequence(...items: Buffer[]): Buffer {
  const content = Buffer.concat(items)
  return Buffer.concat([Buffer.from([0x30]), encodeAsn1Length(content.length), content])
}

function encodeAsn1Integer(value: Buffer): Buffer {
  let buf = value
  if (buf[0]! & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf])
  }
  return Buffer.concat([Buffer.from([0x02]), encodeAsn1Length(buf.length), buf])
}

function encodeAsn1Utf8String(str: string): Buffer {
  const buf = Buffer.from(str, 'utf-8')
  return Buffer.concat([Buffer.from([0x0c]), encodeAsn1Length(buf.length), buf])
}

function encodeAsn1UtcTime(timeStr: string): Buffer {
  const buf = Buffer.from(timeStr, 'ascii')
  return Buffer.concat([Buffer.from([0x17]), encodeAsn1Length(buf.length), buf])
}

function encodeAsn1BitString(data: Buffer): Buffer {
  const content = Buffer.concat([Buffer.from([0x00]), data])
  return Buffer.concat([Buffer.from([0x03]), encodeAsn1Length(content.length), content])
}

function encodeAsn1Oid(oid: number[]): Buffer {
  const bytes: number[] = [oid[0]! * 40 + oid[1]!]
  for (let i = 2; i < oid.length; i++) {
    let value = oid[i]!
    if (value < 128) {
      bytes.push(value)
    } else {
      const encoded: number[] = []
      encoded.push(value & 0x7f)
      value >>= 7
      while (value > 0) {
        encoded.push((value & 0x7f) | 0x80)
        value >>= 7
      }
      encoded.reverse()
      bytes.push(...encoded)
    }
  }
  const buf = Buffer.from(bytes)
  return Buffer.concat([Buffer.from([0x06]), encodeAsn1Length(buf.length), buf])
}

function encodeDistinguishedName(commonName: string): Buffer {
  // CN attribute type OID: 2.5.4.3
  const cnOid = encodeAsn1Oid([2, 5, 4, 3])
  const cnValue = encodeAsn1Utf8String(commonName)
  const atv = encodeAsn1Sequence(cnOid, cnValue)
  // RDN is a SET of attribute-type-value
  const rdnContent = atv
  const rdn = Buffer.concat([Buffer.from([0x31]), encodeAsn1Length(rdnContent.length), rdnContent])
  return encodeAsn1Sequence(rdn)
}

function encodeTbsCertificate(params: {
  serialNumber: Buffer
  issuer: Buffer
  notBefore: string
  notAfter: string
  subject: Buffer
  subjectPublicKeyInfo: Buffer
}): Buffer {
  // ecdsaWithSHA256: 1.2.840.10045.4.3.2
  const signatureAlgorithm = encodeAsn1Sequence(encodeAsn1Oid([1, 2, 840, 10045, 4, 3, 2]))

  const validity = encodeAsn1Sequence(
    encodeAsn1UtcTime(params.notBefore),
    encodeAsn1UtcTime(params.notAfter)
  )

  return encodeAsn1Sequence(
    encodeAsn1Integer(params.serialNumber),
    signatureAlgorithm,
    params.issuer,
    validity,
    params.subject,
    params.subjectPublicKeyInfo
  )
}

function encodeX509Certificate(tbs: Buffer, signature: Buffer): Buffer {
  const signatureAlgorithm = encodeAsn1Sequence(encodeAsn1Oid([1, 2, 840, 10045, 4, 3, 2]))
  return encodeAsn1Sequence(tbs, signatureAlgorithm, encodeAsn1BitString(signature))
}
