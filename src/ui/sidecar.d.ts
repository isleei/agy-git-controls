/** window.sidecar bridge injected by the host via /preload.js. */
export interface SidecarBridge {
  conversationId: string | null;
  fetch(url: string, options?: RequestInit): Promise<Response>;
  getWorkspaceUris(): Promise<string[]>;
  onWorkspaceChange(listener: (uris: string[]) => void): () => void;
  agent: {
    sendMessage(message: string, conversationId?: string): Promise<unknown>;
    startConversation(message: string, title?: string): Promise<unknown>;
    getConversationMetadata(conversationId: string): Promise<unknown>;
  };
  ui: {
    toggleAuxPane(request?: unknown): void;
    toggleConversation(conversationId: string, options?: Record<string, unknown>): void;
    addArtifactComment(args: { uri?: string; comment: string; selection?: string; pageTitle?: string }): void;
  };
  auth: {
    requestCredentialRefresh(): void;
  };
}

declare global {
  interface Window {
    sidecar?: SidecarBridge;
  }
}

export {};
