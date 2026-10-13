import { createSocket } from 'node:dgram';
import { isIPv4 } from 'node:net';
import { normalizeMac } from '../sessions/model.ts';

export interface WolRequest {
  mac: string;
  /** Endereço de broadcast (padrão 255.255.255.255) ou o broadcast da sub-rede, ex.: 10.0.0.255. */
  address: string;
  port: number;
}

export function validateWol(raw: unknown): WolRequest {
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const mac = normalizeMac(String(o.mac ?? ''));
  if (!mac) throw new Error(`MAC inválido: "${String(o.mac ?? '')}" (ex.: aa:bb:cc:dd:ee:ff)`);
  const address = String(o.address ?? '').trim() || '255.255.255.255';
  if (!isIPv4(address)) throw new Error(`endereço de broadcast inválido: "${address}"`);
  const port = o.port === undefined || o.port === '' ? 9 : Number(o.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('porta inválida (use 9 ou 7)');
  return { mac, address, port };
}

/** Pacote mágico: 6 bytes 0xFF seguidos do MAC repetido 16 vezes (102 bytes). */
export function magicPacket(mac: string): Buffer {
  const normalized = normalizeMac(mac);
  if (!normalized) throw new Error(`MAC inválido: "${mac}"`);
  const bytes = Buffer.from(normalized.replace(/:/g, ''), 'hex');
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array.from({ length: 16 }, () => bytes)]);
}

/** Envia o pacote mágico por UDP (broadcast habilitado). */
export function sendWol(req: WolRequest): Promise<void> {
  const packet = magicPacket(req.mac);
  return new Promise((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.once('error', (err) => {
      socket.close();
      reject(new Error(`não foi possível enviar: ${err.message}`));
    });
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, req.port, req.address, (err) => {
        socket.close();
        if (err) reject(new Error(`não foi possível enviar: ${err.message}`));
        else resolve();
      });
    });
  });
}
