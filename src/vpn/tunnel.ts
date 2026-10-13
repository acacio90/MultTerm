import { EventEmitter } from 'node:events';
import { IkeClient, type ChildSa, type IkeConfig, type ModeConfig } from './ike/client.ts';
import { EspDecrypt, EspEncrypt } from './esp.ts';
import type { Tun } from './wintun.ts';

/*
 * Túnel completo: IKE (fase 1 + XAuth + Mode Config), uma fase 2 por rede, roteamento dos
 * pacotes do adaptador para a SA certa (maior prefixo), checagem de política na entrada,
 * renovação das SAs antes de expirar, reconexão perto do fim da fase 1 e DPD.
 */

export interface NetSetup {
  address: string;
  dns: string[];
  domain?: string;
  networks: string[];
}

/** Configuração de rede do adaptador (IP, rotas, DNS); injetável nos testes. */
export interface NetConfig {
  apply(tun: Tun, setup: NetSetup): Promise<void>;
  /** Desfaz o que não some sozinho com o adaptador (ex.: rota do gateway). */
  clear(): Promise<void>;
}

export interface TunnelOptions {
  ike: IkeConfig;
  /** Endereço fixo quando o Mode Config está desligado. */
  staticAddress?: string;
  /** Redes manuais (sobrepõem as do gateway). */
  networks?: string[];
  /** DNS: usar os do gateway, fixos ou nenhum. */
  dns?: { use: boolean; servers?: string[]; domain?: string };
  createTun: () => Tun;
  net: NetConfig;
  /** Intervalo do DPD (ms); 0 desliga. */
  dpdIntervalMs?: number;
}

interface Route {
  net: number;
  mask: number;
  bits: number;
  cidr: string;
  child: ChildSa;
  out: EspEncrypt;
}

const parseIp = (s: string) => s.split('.').reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);

export function parseCidr(cidr: string): { net: number; mask: number; bits: number } {
  const [ip, b] = cidr.split('/');
  const bits = Number(b ?? 32);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return { net: (parseIp(ip) & mask) >>> 0, mask, bits };
}

export interface TunnelStats {
  bytesIn: number;
  bytesOut: number;
  packetsIn: number;
  packetsOut: number;
  dropped: number;
}

export class Tunnel extends EventEmitter {
  private readonly opts: TunnelOptions;
  private ike?: IkeClient;
  private tun?: Tun;
  private routes: Route[] = [];
  private inbound = new Map<string, { dec: EspDecrypt; route: Route }>();
  private timers: NodeJS.Timeout[] = [];
  private lastInbound = Date.now();
  private stopping = false;
  setup?: NetSetup;
  stats: TunnelStats = { bytesIn: 0, bytesOut: 0, packetsIn: 0, packetsOut: 0, dropped: 0 };

  constructor(opts: TunnelOptions) {
    super();
    this.opts = opts;
  }

  private log(msg: string) {
    this.emit('log', msg);
  }

  private async negotiate(): Promise<{ ike: IkeClient; mc?: ModeConfig }> {
    const ike = new IkeClient(this.opts.ike);
    ike.on('log', (m: string) => this.log(m));
    ike.on('error', (err: Error) => this.emit('ike-error', err));
    const mc = await ike.connect();
    return { ike, mc };
  }

  /** Conecta, cria o adaptador e configura a rede. */
  async start(): Promise<NetSetup> {
    const { ike, mc } = await this.negotiate();
    const address = mc?.address ?? this.opts.staticAddress;
    if (!address) {
      ike.close();
      throw new Error('sem endereço na VPN (o gateway não enviou e não há endereço fixo no site)');
    }
    const networks = this.opts.networks?.length ? this.opts.networks : mc?.networks.length ? mc.networks : ['0.0.0.0/0'];
    const dnsOpt = this.opts.dns ?? { use: true };
    const setup: NetSetup = {
      address,
      dns: dnsOpt.use ? (dnsOpt.servers?.length ? dnsOpt.servers : mc?.dns ?? []) : [],
      ...(dnsOpt.use && (dnsOpt.domain ?? mc?.domain) ? { domain: dnsOpt.domain ?? mc?.domain } : {}),
      networks,
    };
    try {
      await this.attach(ike, setup);
      this.tun = this.opts.createTun();
      this.tun.onPacket = (ip) => this.outbound(ip);
      await this.opts.net.apply(this.tun, setup);
    } catch (err) {
      this.stop();
      throw err;
    }
    this.setup = setup;
    if (mc?.banner) this.emit('banner', mc.banner);
    this.schedulePhase1(ike);
    this.startDpd();
    this.log(`túnel ativo: ${address} → ${networks.join(', ')}`);
    return setup;
  }

  /** Negocia as fases 2 numa conexão IKE e passa a usá-la. */
  private async attach(ike: IkeClient, setup: NetSetup) {
    const routes: Route[] = [];
    for (const cidr of setup.networks) routes.push(await this.child(ike, setup.address, cidr));
    // O gateway instala as SAs depois do QM3: espera um instante antes de usar.
    await new Promise((r) => setTimeout(r, 250));
    const old = this.ike;
    this.ike = ike;
    ike.onEsp = (p) => this.inboundEsp(p);
    ike.on('closed', (reason: string) => {
      if (this.ike === ike && !this.stopping) this.emit('down', reason);
    });
    this.routes = routes.sort((a, b) => b.bits - a.bits);
    if (old) {
      // Mantém as SAs antigas de entrada um pouco (pacotes em trânsito) e encerra a conexão velha.
      setTimeout(() => old.close(), 10_000).unref();
    }
  }

  private async child(ike: IkeClient, address: string, cidr: string): Promise<Route> {
    const child = await ike.quickMode(address, cidr);
    const { net, mask, bits } = parseCidr(cidr);
    const route: Route = { net, mask, bits, cidr, child, out: new EspEncrypt(child.outbound) };
    this.inbound.set(child.inbound.spi.toString('hex'), { dec: new EspDecrypt(child.inbound), route });
    // Renova a fase 2 com folga antes de expirar.
    const t = setTimeout(() => void this.rekeyChild(ike, route), Math.max(30, child.lifetime * 0.85) * 1000);
    t.unref();
    this.timers.push(t);
    return route;
  }

  private async rekeyChild(ike: IkeClient, route: Route) {
    if (this.stopping || this.ike !== ike || !this.setup) return;
    try {
      const fresh = await this.child(ike, this.setup.address, route.cidr);
      await new Promise((r) => setTimeout(r, 250));
      this.routes = this.routes.map((r) => (r === route ? fresh : r));
      this.log(`fase 2 renovada para ${route.cidr}`);
      setTimeout(() => {
        this.inbound.delete(route.child.inbound.spi.toString('hex'));
        ike.deleteChild(route.child);
      }, 10_000).unref();
    } catch (err) {
      this.log(`falha ao renovar a fase 2 de ${route.cidr}: ${(err as Error).message}`);
      this.emit('down', 'não foi possível renovar a conexão');
    }
  }

  /** Perto do fim da fase 1, negocia uma conexão nova e troca sem derrubar o adaptador. */
  private schedulePhase1(ike: IkeClient) {
    const life = (this.opts.ike.phase1Life ?? 86400) * 0.9 * 1000;
    const t = setTimeout(async () => {
      if (this.stopping || this.ike !== ike || !this.setup) return;
      try {
        this.log('renovando a fase 1');
        const { ike: fresh } = await this.negotiate();
        await this.attach(fresh, this.setup);
        this.schedulePhase1(fresh);
      } catch (err) {
        this.log(`falha ao renovar a fase 1: ${(err as Error).message}`);
        this.emit('down', 'não foi possível renovar a conexão');
      }
    }, life);
    t.unref();
    this.timers.push(t);
  }

  private startDpd() {
    const every = this.opts.dpdIntervalMs ?? 15_000;
    if (!every) return;
    let misses = 0;
    const t = setInterval(async () => {
      const ike = this.ike;
      if (!ike || this.stopping || !ike.supportsDpd) return;
      if (Date.now() - this.lastInbound < every * 2) {
        misses = 0;
        return;
      }
      if (await ike.probe()) {
        misses = 0;
        this.lastInbound = Date.now();
      } else if (++misses >= 3) {
        this.log('o gateway parou de responder (DPD)');
        this.emit('down', 'o gateway parou de responder');
      }
    }, every);
    t.unref();
    this.timers.push(t);
  }

  private outbound(ip: Buffer) {
    if (ip.length < 20 || ip[0] >> 4 !== 4) return; // só IPv4
    const dst = ip.readUInt32BE(16);
    const route = this.routes.find((r) => ((dst & r.mask) >>> 0) === r.net);
    if (!route || !this.ike) {
      this.stats.dropped++;
      return;
    }
    this.ike.sendEsp(route.out.encapsulate(ip));
    this.stats.packetsOut++;
    this.stats.bytesOut += ip.length;
  }

  private inboundEsp(packet: Buffer) {
    const sa = this.inbound.get(packet.subarray(0, 4).toString('hex'));
    if (!sa || !this.tun) {
      this.stats.dropped++;
      return;
    }
    let ip: Buffer;
    try {
      ip = sa.dec.decapsulate(packet);
    } catch {
      this.stats.dropped++;
      return;
    }
    this.lastInbound = Date.now();
    // Política: origem dentro da rede da SA e destino = nosso endereço.
    const src = ip.length >= 20 ? ip.readUInt32BE(12) : -1;
    const dst = ip.length >= 20 ? ip.readUInt32BE(16) : -1;
    const r = sa.route;
    if (((src & r.mask) >>> 0) !== r.net || (this.setup && dst !== parseIp(this.setup.address))) {
      this.stats.dropped++;
      return;
    }
    this.tun.write(ip);
    this.stats.packetsIn++;
    this.stats.bytesIn += ip.length;
  }

  /** Avisa o gateway, desfaz a rede e fecha o adaptador. */
  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    for (const t of this.timers) clearTimeout(t);
    this.ike?.close();
    await this.opts.net.clear().catch(() => {});
    this.tun?.close();
  }
}
