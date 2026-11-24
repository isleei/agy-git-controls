/**
 * Type declarations for the host-provided `sidecar_sdk` module
 * (resolved by Antigravity's register_loader at runtime).
 * Source of truth: ~/.gemini/antigravity/lib/node_modules/sidecar_sdk/index.mjs
 */
declare module 'sidecar_sdk' {
  export class Response {
    constructor(
      body: string | Buffer,
      opts?: { contentType?: string; status?: number; headers?: Record<string, string> },
    );
    body: string | Buffer;
    contentType: string;
    status: number;
    headers?: Record<string, string>;
  }

  export type ApiHandler = (
    data: Record<string, unknown>,
  ) => unknown | Promise<unknown>;

  export class SidecarApp {
    constructor();
    readonly config: { projectId?: string; conversationId?: string };
    sendMessage(
      conversationId: string,
      message: string,
      opts?: { title?: string; projectId?: string },
    ): Record<string, unknown>;
    startConversation(
      message: string,
      opts?: { model?: string; projectId?: string },
    ): Record<string, unknown>;
    getConversationMetadata(conversationId: string): Record<string, unknown>;
    page(path: string, handler: () => string | Response | Promise<string | Response>): void;
    api(path: string, handler: ApiHandler, method?: 'GET' | 'POST'): void;
    run(): Promise<import('node:http').Server>;
    close(): Promise<void>;
  }
}
