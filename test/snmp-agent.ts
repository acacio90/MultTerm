// Agente SNMP local para os testes (v1/v2c com community "public" e um usuário v3 authPriv).
import { createSocket } from 'node:dgram';
import snmp from 'net-snmp';

export const V3_USER = { name: 'mt-user', authProtocol: 'sha', authKey: 'senha-auth-123', privProtocol: 'aes', privKey: 'senha-priv-123' };

async function freeUdpPort(): Promise<number> {
  const s = createSocket('udp4');
  await new Promise<void>((r) => s.bind(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

export async function startAgent(): Promise<{ port: number; close: () => Promise<void> }> {
  const port = await freeUdpPort();
  const agent = snmp.createAgent({ port, address: '127.0.0.1' }, () => {});
  const auth = agent.getAuthorizer();
  auth.addCommunity('public');
  auth.addUser({
    name: V3_USER.name,
    level: snmp.SecurityLevel.authPriv,
    authProtocol: snmp.AuthProtocols.sha,
    authKey: V3_USER.authKey,
    privProtocol: snmp.PrivProtocols.aes,
    privKey: V3_USER.privKey,
  });
  const mib = agent.getMib();
  const scalar = (name: string, oid: string, type: number, value: unknown) => {
    mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid, scalarType: type, maxAccess: snmp.MaxAccess['read-only'] });
    mib.setScalarValue(name, value);
  };
  scalar('sysDescr', '1.3.6.1.2.1.1.1', snmp.ObjectType.OctetString, 'Agente de teste do MultTerm');
  scalar('sysObjectID', '1.3.6.1.2.1.1.2', snmp.ObjectType.OID, '1.3.6.1.4.1.99999');
  scalar('sysUpTime', '1.3.6.1.2.1.1.3', snmp.ObjectType.TimeTicks, 27_000_000); // 3d 03:00:00
  scalar('sysName', '1.3.6.1.2.1.1.5', snmp.ObjectType.OctetString, 'agente-teste');
  scalar('sysLocation', '1.3.6.1.2.1.1.6', snmp.ObjectType.OctetString, 'Laboratório');
  scalar('mac', '1.3.6.1.4.1.99999.1', snmp.ObjectType.OctetString, Buffer.from([0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e]));
  scalar('big', '1.3.6.1.4.1.99999.2', snmp.ObjectType.Counter64, Buffer.from('0000000100000000', 'hex')); // 2^32
  await new Promise((r) => setTimeout(r, 100));
  return { port, close: () => new Promise((r) => agent.close(() => r())) };
}
