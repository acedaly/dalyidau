// QR labels: an SVG code for an asset's address (src/shared/assets/address.ts). The code holds no
// name, serial, location or value. Regenerating a label (for a reprint) bumps the version printed
// on it; the address, and so every label already printed, stays valid.
import QRCode from "qrcode";

export { assetAddress, parseAssetAddress } from "../../src/shared/assets/address";

/** An SVG QR code (error correction M) for an address. Black on white, for printing. */
export const qrSvg = (address: string) =>
    QRCode.toString(address, { type: "svg", errorCorrectionLevel: "M", margin: 2, width: 256, color: { dark: "#000000", light: "#ffffff" } });
