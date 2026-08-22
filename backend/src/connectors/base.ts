export type ToolResponseType = "json" | "text";

export interface MCPTool {
  name: string;
  description: string;
  endpoint: string;
  method?: "GET" | "POST";
  responseType?: ToolResponseType;
}

export interface ConnectorMetadata {
  domain: string;
  apiKeyRequired: boolean;
  status: "available" | "placeholder";
}

export interface MCPConnectorConfig {
  baseUrl: string;
  description: string;
  tools: MCPTool[];
  metadata?: ConnectorMetadata;
}

export class MCPConnector {
  readonly name: string;
  readonly config: MCPConnectorConfig;

  constructor(name: string, config: MCPConnectorConfig) {
    this.name = name;
    this.config = config;
  }

  private __handlingTool = "";

  async call(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const tool = this.config.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(
        `Unknown tool "${toolName}" for connector "${this.name}". Available: ${this.config.tools
          .map((t) => t.name)
          .join(", ")}`,
      );
    }

    const handler = (this as unknown as Record<string, unknown>)[toolName];
    if (typeof handler === "function" && toolName in this && this.__handlingTool !== toolName) {
      this.__handlingTool = toolName;
      try {
        return await (handler as (p: Record<string, unknown>) => Promise<unknown>).call(this, params);
      } finally {
        this.__handlingTool = "";
      }
    }

    let path = tool.endpoint;
    const remaining: Record<string, unknown> = { ...params };
    for (const key of Object.keys(remaining)) {
      if (path.includes(`{${key}}`)) {
        path = path.replaceAll(`{${key}}`, encodeURIComponent(String(remaining[key])));
        delete remaining[key];
      }
    }

    const url = path.startsWith("http")
      ? new URL(path)
      : new URL(path.replace(/^\//, ""), this.config.baseUrl.endsWith("/") ? this.config.baseUrl : this.config.baseUrl + "/");
    const isText = tool.responseType === "text";
    const isPost = (tool.method ?? "GET") === "POST";
    const headers: Record<string, string> = { Accept: isText ? "*/*" : "application/json" };

    if (isPost) {
      headers["Content-Type"] = "application/json";
    } else {
      for (const [key, value] of Object.entries(remaining)) {
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method: tool.method ?? "GET",
      headers,
      body: isPost ? JSON.stringify(remaining) : undefined,
    });
    if (!response.ok) {
      throw new Error(
        `Connector "${this.name}" tool "${toolName}" failed: HTTP ${response.status}`,
      );
    }
    return isText ? response.text() : response.json();
  }

  listTools(): MCPTool[] {
    return this.config.tools.map((tool) => ({ ...tool }));
  }
}
