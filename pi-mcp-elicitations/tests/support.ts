import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import type { ElicitationUi } from "../src/elicit.ts";

export class ScriptedTransport {
  readonly sent: JsonRpcMessage[] = [];
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly handle: (message: JsonRpcMessage, reply: (message: JsonRpcMessage) => void) => void;

  constructor(handle: (message: JsonRpcMessage, reply: (message: JsonRpcMessage) => void) => void) {
    this.handle = handle;
  }

  async start(): Promise<void> {}

  async close(): Promise<void> {}

  onMessage(listener: (message: JsonRpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onError(): () => void {
    return () => {};
  }

  onClose(): () => void {
    return () => {};
  }

  setProtocolVersion(): void {}

  inject(message: JsonRpcMessage): void {
    for (const listener of this.listeners) listener(message);
  }

  async send(message: JsonRpcMessage): Promise<void> {
    this.sent.push(message);
    this.handle(message, (reply) => {
      for (const listener of this.listeners) listener(reply);
    });
  }
}

export class ScriptedUi implements ElicitationUi {
  readonly selects: { title: string; options: string[] }[] = [];
  readonly editors: { title: string; prefill?: string }[] = [];
  readonly notes: string[] = [];
  readonly opened: string[] = [];
  private readonly answers: Array<string | undefined>;

  constructor(answers: Array<string | undefined>) {
    this.answers = answers;
  }

  async select(title: string, options: string[]): Promise<string | undefined> {
    this.selects.push({ title, options });
    return this.answers.shift();
  }

  async input(title: string): Promise<string | undefined> {
    this.editors.push({ title });
    return this.answers.shift();
  }

  async editor(title: string, prefill?: string): Promise<string | undefined> {
    this.editors.push({ title, prefill });
    return this.answers.shift();
  }

  notify(message: string): void {
    this.notes.push(message);
  }
}

export function routingUi(): ElicitationUi & { opened: string[] } {
  const opened: string[] = [];
  return {
    opened,
    async select(_title, options) {
      if (options.includes("Answer")) return "Answer";
      if (options.includes("Accept")) return "Accept";
      if (options.includes("Yes")) return "Yes";
      if (options[0]) return options[0];
      return "Cancel";
    },
    async editor(title, prefill) {
      if (title.startsWith("server-a")) return "from-a";
      if (title.startsWith("server-b")) return "from-b";
      return prefill ?? "";
    },
    async input() {
      return undefined;
    },
    notify() {},
  };
}
