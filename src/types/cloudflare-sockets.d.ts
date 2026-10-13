declare module "cloudflare:sockets" {
    import type { Socket, SocketAddress, SocketOptions } from "@cloudflare/workers-types";

    export function connect(address: string | SocketAddress, options?: SocketOptions): Socket;
    export type { Socket };
}
