/**
 * Complemento das mensagens de "cifra indisponível" (safeStorage): no Linux, o Electron cifra com
 * o chaveiro da sessão (Secret Service do GNOME Keyring/KeePassXC ou o KWallet).
 */
export const KEYRING_HINT = process.platform === 'linux'
  ? ' (no Linux, é preciso um chaveiro ativo na sessão: GNOME Keyring, KWallet ou KeePassXC com o Secret Service)'
  : '';
