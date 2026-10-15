/**
 * ch340.js — CH340/CH341 USB-serial driver over WebUSB.
 *
 * Chrome on Android has no Web Serial access to USB serial adapters, but it
 * does support WebUSB. This module drives the TA612C's built-in CH340 chip
 * directly and exposes a minimal SerialPort look-alike (open, readable,
 * writable, close) so WebSerialTransport can use it unchanged.
 *
 * Init sequence follows the Linux ch341 driver (drivers/usb/serial/ch341.c).
 */

const USB_FILTERS = [
  { vendorId: 0x1a86, productId: 0x7523 }, // CH340
  { vendorId: 0x1a86, productId: 0x7522 }, // CH340K
  { vendorId: 0x1a86, productId: 0x5523 }, // CH341 in serial mode
  { vendorId: 0x4348, productId: 0x5523 }, // CH341 (older vendor ID)
];

// Vendor control requests
const REQ_READ_VERSION = 0x5f;
const REQ_WRITE_REG    = 0x9a;
const REQ_SERIAL_INIT  = 0xa1;
const REQ_MODEM_CTRL   = 0xa4;

// Register pairs, written as (regB << 8 | regA)
const REG_DIVISOR_PRESCALER = 0x1312;
const REG_LCR2_LCR          = 0x2518;

// Divisor/prescaler value for 9600 baud (ps=2, fact=0, div=78), as computed
// by ch341_get_divisor() in the Linux driver. The TA612C only talks 9600.
const DIVISOR_9600 = 0xb202;
// Without this bit the chip holds received bytes until a full 32-byte packet
// is buffered. Chip version 0x27 has the bit inverted.
const DIVISOR_SEND_IMMEDIATELY = 0x80;

const LCR_ENABLE_RX = 0x80;
const LCR_ENABLE_TX = 0x40;
const LCR_CS8       = 0x03;

const MCR_DTR = 0x20;
const MCR_RTS = 0x40;

export function isWebUsbSupported() {
  return 'usb' in navigator;
}

/** Show the browser's USB device chooser filtered to CH340/CH341 chips. */
export async function requestCh340Port() {
  const device = await navigator.usb.requestDevice({ filters: USB_FILTERS });
  return new Ch340Port(device);
}

class Ch340Port {
  #device;
  #epIn = null;
  #epOut = null;
  #readable = null;
  #writable = null;

  constructor(device) {
    this.#device = device;
  }

  /** Like SerialPort.readable: a fresh stream after a read error, null once the device is gone. */
  get readable() {
    if (!this.#device.opened) return null;
    if (!this.#readable) this.#readable = this.#createReadable();
    return this.#readable;
  }

  get writable() {
    if (!this.#device.opened) return null;
    if (!this.#writable) this.#writable = this.#createWritable();
    return this.#writable;
  }

  async open({ baudRate } = {}) {
    if (baudRate !== 9600) throw new Error(`CH340 driver only supports 9600 baud (got ${baudRate})`);
    const dev = this.#device;
    await dev.open();
    try {
      if (dev.configuration === null) await dev.selectConfiguration(1);
      const iface = dev.configuration.interfaces[0];
      await dev.claimInterface(iface.interfaceNumber);

      const bulk = iface.alternate.endpoints.filter(ep => ep.type === 'bulk');
      this.#epIn = bulk.find(ep => ep.direction === 'in');
      this.#epOut = bulk.find(ep => ep.direction === 'out');
      if (!this.#epIn || !this.#epOut) throw new Error('CH340 bulk endpoints not found');

      const version = (await this.#controlIn(REQ_READ_VERSION, 0, 2)).getUint8(0);
      await this.#controlOut(REQ_SERIAL_INIT, 0, 0);
      const divisor = DIVISOR_9600 | (version > 0x27 ? DIVISOR_SEND_IMMEDIATELY : 0);
      await this.#controlOut(REQ_WRITE_REG, REG_DIVISOR_PRESCALER, divisor);
      // Chips before 0x30 use separate line-control registers that default to 8N1
      if (version >= 0x30) {
        await this.#controlOut(REQ_WRITE_REG, REG_LCR2_LCR, LCR_ENABLE_RX | LCR_ENABLE_TX | LCR_CS8);
      }
      // Assert DTR + RTS (active-low register), as Web Serial and pyserial do on open
      await this.#controlOut(REQ_MODEM_CTRL, ~(MCR_DTR | MCR_RTS) & 0xffff, 0);
    } catch (err) {
      await dev.close().catch(() => {});
      throw err;
    }
  }

  async close() {
    this.#readable = null;
    this.#writable = null;
    if (!this.#device.opened) return;
    try { await this.#controlOut(REQ_MODEM_CTRL, 0xffff, 0); } catch (_) {} // drop DTR + RTS
    await this.#device.close(); // also aborts any pending transfer
  }

  #createReadable() {
    const { endpointNumber, packetSize } = this.#epIn;
    let cancelled = false;
    return new ReadableStream({
      pull: async (controller) => {
        // Loop until bytes arrive: pull() is not re-invoked if it resolves without enqueuing
        try {
          while (!cancelled) {
            const result = await this.#device.transferIn(endpointNumber, packetSize);
            if (cancelled) return;
            if (result.status === 'stall') {
              await this.#device.clearHalt('in', endpointNumber);
            } else if (result.data?.byteLength) {
              const { buffer, byteOffset, byteLength } = result.data;
              controller.enqueue(new Uint8Array(buffer, byteOffset, byteLength));
              return;
            }
          }
        } catch (err) {
          this.#readable = null;
          if (!cancelled) controller.error(err);
        }
      },
      cancel: () => {
        cancelled = true;
        this.#readable = null;
      },
    });
  }

  #createWritable() {
    return new WritableStream({
      write: async (chunk) => {
        const result = await this.#device.transferOut(this.#epOut.endpointNumber, chunk);
        if (result.status !== 'ok') throw new Error(`USB write failed (${result.status})`);
      },
    });
  }

  async #controlIn(request, value, length) {
    const result = await this.#device.controlTransferIn(
      { requestType: 'vendor', recipient: 'device', request, value, index: 0 }, length);
    if (result.status !== 'ok') throw new Error(`CH340 request 0x${request.toString(16)} failed (${result.status})`);
    return result.data;
  }

  async #controlOut(request, value, index) {
    const result = await this.#device.controlTransferOut(
      { requestType: 'vendor', recipient: 'device', request, value, index });
    if (result.status !== 'ok') throw new Error(`CH340 request 0x${request.toString(16)} failed (${result.status})`);
  }
}
