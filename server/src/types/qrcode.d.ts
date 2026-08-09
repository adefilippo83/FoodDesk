declare module 'qrcode' {
  const QRCode: {
    toBuffer(text: string, opts?: { width?: number; margin?: number }): Promise<Buffer>
  }
  export default QRCode
}
