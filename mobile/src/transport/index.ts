export { connect, type RpcClient } from './rpc-client'
export { loadHosts, saveHost, removeHost, updateLastConnected } from './host-store'
export type {
  RpcRequest,
  RpcResponse,
  RpcSuccess,
  RpcFailure,
  ConnectionState,
  HostProfile,
  PairingOffer
} from './types'
export { PairingOfferV1, PAIRING_OFFER_VERSION } from './types'
