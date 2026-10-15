/**
 * ConnectionManager — picks transport based on browser capabilities,
 * re-emits events through a single interface.
 *
 * Events: 'connected', 'disconnected', 'reading', 'info', 'record', 'log', 'error'
 */
import { WebSerialTransport } from './serial.js';
import { WebSocketTransport } from './websocket.js';
import { isWebUsbSupported, requestCh340Port } from './ch340.js';

// Android Chrome can't reach USB serial adapters through Web Serial, but it
// can drive the TA612C's CH340 chip directly over WebUSB (USB-OTG).
const USE_WEBUSB = isWebUsbSupported() &&
  (!WebSerialTransport.isSupported() || /Android/i.test(navigator.userAgent));

export class ConnectionManager extends EventTarget {
  #transport = null;
  #connected = false;

  get hasUsb() {
    return USE_WEBUSB || WebSerialTransport.isSupported();
  }

  get isConnected() {
    return this.#connected;
  }

  async connectSerial() {
    if (this.#connected) await this.disconnect();
    this.#transport = new WebSerialTransport();
    this.#wire();
    await this.#transport.connect(USE_WEBUSB ? requestCh340Port : undefined);
  }

  async connectWebSocket(url) {
    if (this.#connected) await this.disconnect();
    this.#transport = new WebSocketTransport();
    this.#wire();
    await this.#transport.connect(url);
  }

  async disconnect() {
    if (this.#transport) {
      await this.#transport.disconnect();
      this.#transport = null;
    }
  }

  async send(cmdBytes) {
    if (this.#transport) {
      await this.#transport.send(cmdBytes);
    }
  }

  #wire() {
    const events = ['connected', 'disconnected', 'reading', 'info', 'record', 'log', 'error'];
    for (const name of events) {
      this.#transport.addEventListener(name, (e) => {
        if (name === 'connected') this.#connected = true;
        if (name === 'disconnected') this.#connected = false;
        this.dispatchEvent(new CustomEvent(name, { detail: e.detail }));
      });
    }
  }
}
