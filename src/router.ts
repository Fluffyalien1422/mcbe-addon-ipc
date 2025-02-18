import {
  InternalInvokeOptions,
  InvokeOptions,
  IpcTypeFlag,
  ScriptEventListener,
  SendOptions,
  SerializableValue,
} from "./common.js";
import { send, sendInternal, sendStream, sendStreamInternal } from "./send.js";
import { Failure } from "./failure.js";
import { ScriptEventCommandMessageAfterEvent, system } from "@minecraft/server";
import { MAX_MESSAGE_LENGTH, MAX_ROUTER_UID_LENGTH } from "./constants.js";

/**
 * An IPC router. This must be constructed to send and recieve IPC events.
 */
export class Router {
  private internalIsValid = true;
  /**
   * key = stream ID
   * value = cached content from previous events
   */
  private pendingStreams = new Map<string, string>();
  private listeners = new Map<string, ScriptEventListener>();
  /**
   * total number of listener uids generated by this router, used to create unique listener IDs for invoke responses.
   */
  private listenerUidsGenerated = 0;
  /**
   * total number of steam uids generated by this router, used to create unique stream IDs.
   */
  private streamUidsGenerated = 0;

  /**
   * @throws Throws if the UID is invalid.
   */
  constructor(
    /**
     * A **unique** ID for this router. If another router has the same ID, it may cause problems.
     * Must be less characters than {@link MAX_ROUTER_UID_LENGTH}.
     */
    readonly uid: string
  ) {
    if (!uid || uid.length > MAX_ROUTER_UID_LENGTH) {
      throw new Error(
        `Router UID must be at least one character and less than ${MAX_ROUTER_UID_LENGTH.toString()} characters.`
      );
    }

    system.afterEvents.scriptEventReceive.subscribe(this.onScriptEventRecieved);
  }

  /**
   * Has this object been destroyed?
   */
  get isValid(): boolean {
    return this.internalIsValid;
  }

  /**
   * Unsubscribe from all Minecraft events and mark this object as invalid.
   */
  destroy(): void {
    system.afterEvents.scriptEventReceive.unsubscribe(
      this.onScriptEventRecieved
    );
    this.internalIsValid = false;
  }

  /**
   * Registers an IPC listener.
   * @param event The listener ID.
   * @param callback The callback.
   * @throws Throws if another listener is registered with the same ID.
   */
  registerListener(event: string, callback: ScriptEventListener): void {
    if (this.listeners.has(event)) {
      throw new Error(
        `Failed to register listener '${event}'. A listener with this ID has already been registered.`
      );
    }

    if (!event.includes(":") || event.split(":")[1].startsWith("_")) {
      throw new Error(
        `Failed to register listener '${event}'. Listener IDs must have a namespace and cannot start with an underscore after the namespace.`
      );
    }

    this.listeners.set(event, callback);
  }

  /**
   * Removes a listener for an event.
   * @param event The event ID.
   * @returns Returns a boolean indicating whether the listener was removed or not.
   */
  removeListener(event: string): boolean {
    return this.listeners.delete(event);
  }

  /**
   * Send a one-way IPC event.
   * @throws Throws if the message is too long.
   */
  send(options: SendOptions): void {
    send(options);
  }

  /**
   * Stream a one-way IPC event. The payload has no max length, since it is streamed.
   */
  sendStream(options: SendOptions): Promise<void> {
    return sendStream(options, this.generateStreamUid());
  }

  /**
   * Send or stream a one-way IPC event. If the payload is greater than the max length then it will be streamed.
   */
  async sendAuto(options: SendOptions): Promise<void> {
    const serialized = JSON.stringify(options.payload);

    if (serialized.length > MAX_MESSAGE_LENGTH) {
      return sendStreamInternal(
        IpcTypeFlag.SendStream,
        options.event,
        serialized,
        this.generateStreamUid(),
        options.force
      );
    }

    sendInternal(IpcTypeFlag.Send, {
      ...options,
      payload: serialized,
    });
  }

  /**
   * Send a two-way IPC event.
   * @returns Returns whatever the listener returns.
   * @throws Throws if a response is not recieved within 20 game ticks.
   * @throws Throws if the message is too long.
   */
  invoke(options: InvokeOptions): Promise<SerializableValue> {
    return this.invokeInternal(
      {
        ...options,
        payload: JSON.stringify(options.payload),
      },
      this.generateListenerUid()
    );
  }

  /**
   * Stream a two-way IPC event. The payload has no max length since it is streamed.
   * @returns Returns whatever the listener returns.
   * @throws Throws if a response is not recieved within 20 game ticks (after the entire payload has been streamed).
   * @throws Throws if the message is too long.
   */
  invokeStream(options: InvokeOptions): Promise<SerializableValue> {
    return this.invokeStreamInternal(
      {
        ...options,
        payload: JSON.stringify(options.payload),
      },
      this.generateListenerUid(),
      this.generateStreamUid()
    );
  }

  /**
   * Send or stream a two-way IPC event. If the payload is greater than the max length then it will be streamed.
   * @returns Returns whatever the target listener returns.
   * @throws Throws if a response is not recieved within 20 game ticks (after the entire payload has been streamed).
   */
  invokeAuto(options: InvokeOptions): Promise<SerializableValue> {
    const serialized = JSON.stringify(options.payload);
    const responseListenerId = this.generateListenerUid();

    const actualPayloadLength =
      // additional character for the space between the response listener ID and the payload
      serialized.length + responseListenerId.length + 1;

    if (actualPayloadLength > MAX_MESSAGE_LENGTH) {
      return this.invokeStreamInternal(
        { ...options, payload: serialized },
        responseListenerId,
        this.generateStreamUid()
      );
    }
    return this.invokeInternal(
      { ...options, payload: serialized },
      responseListenerId
    );
  }

  private setListener(event: string, callback: ScriptEventListener): void {
    this.listeners.set(event, callback);
  }

  private invokeInternal(
    options: InternalInvokeOptions,
    responseListenerId: string
  ): Promise<SerializableValue> {
    return new Promise((resolve, reject) => {
      const timeoutId = system.runTimeout(() => {
        this.removeListener(responseListenerId);
        reject(new Error(`Invoke '${options.event}' timed out.`));
      }, 20);

      this.setListener(responseListenerId, (payload) => {
        this.removeListener(responseListenerId);
        system.clearRun(timeoutId);

        if (payload instanceof Failure && options.throwFailures) {
          reject(payload);
        } else {
          resolve(payload);
        }

        return null;
      });

      sendInternal(IpcTypeFlag.Invoke, {
        ...options,
        payload: `${responseListenerId} ${options.payload}`,
      });
    });
  }

  private invokeStreamInternal(
    options: InternalInvokeOptions,
    responseListenerId: string,
    streamId: string
  ): Promise<SerializableValue> {
    let timeoutId: number | undefined;

    return new Promise((resolve, reject) => {
      this.setListener(responseListenerId, (payload) => {
        this.removeListener(responseListenerId);
        if (timeoutId !== undefined) {
          system.clearRun(timeoutId);
        }

        if (payload instanceof Failure && options.throwFailures) {
          reject(payload);
        } else {
          resolve(payload);
        }

        return null;
      });

      void sendStreamInternal(
        IpcTypeFlag.InvokeStream,
        options.event,
        `${responseListenerId} ${options.payload}`,
        streamId,
        options.force
      ).finally(() => {
        timeoutId = system.runTimeout(() => {
          this.removeListener(responseListenerId);
          reject(new Error(`Invoke '${options.event}' timed out.`));
        }, 20);
      });
    });
  }

  private generateListenerUid(): string {
    return `${this.uid}:__${(this.listenerUidsGenerated++).toString(36)}`;
  }

  private generateStreamUid(): string {
    return this.uid + (this.streamUidsGenerated++).toString(36);
  }

  private parseRawPayload(rawPayload: string): SerializableValue {
    const payload = JSON.parse(rawPayload) as SerializableValue;

    if (
      typeof payload === "object" &&
      payload !== null &&
      "__IPCFAILURE__" in payload
    ) {
      return new Failure(payload.__IPCFAILURE__ as string);
    }

    return payload;
  }

  private async invokeListener(
    listener: ScriptEventListener,
    responseEvent: string,
    rawPayload: string
  ): Promise<void> {
    const payload = this.parseRawPayload(rawPayload);

    let response: SerializableValue = null;
    let err;

    try {
      response = await listener(payload);
    } catch (e) {
      err = e;
    }

    if (response instanceof Failure) {
      response = {
        __IPCFAILURE__: response.message,
      };
    }

    void this.sendAuto({
      event: responseEvent,
      payload: response,
    });

    if (err) {
      console.warn(err);
    }
  }

  private async callListener(
    listener: ScriptEventListener,
    rawPayload: string
  ): Promise<void> {
    const payload = this.parseRawPayload(rawPayload);

    try {
      const result = await listener(payload);
      if (result instanceof Failure) {
        console.warn(result);
      }
    } catch (err) {
      console.warn(err);
    }
  }

  private routeEvent(id: string, rawMsg: string): void {
    const listener = this.listeners.get(id);
    if (!listener) return;

    // the first character should be the ipc type flag
    const ipcTypeFlag = rawMsg[0] as IpcTypeFlag;

    // skip the ipc type flag
    const message = rawMsg.slice(1);

    switch (ipcTypeFlag) {
      case IpcTypeFlag.Send:
        void this.callListener(listener, message);
        break;

      case IpcTypeFlag.Invoke: {
        const [responseEvent, payload] = message.split(/ (.*)/);
        void this.invokeListener(listener, responseEvent, payload);
        break;
      }

      case IpcTypeFlag.InvokeStream:
      case IpcTypeFlag.SendStream: {
        const [id, afterId] = message.split(/ (.*)/);
        const [isEndRaw, content] = afterId.split(/ (.*)/);

        const isEnd = isEndRaw === "t";

        const cachedContent = this.pendingStreams.get(id) ?? "";

        const fullContent = cachedContent + content;

        if (!isEnd) {
          this.pendingStreams.set(id, fullContent);
          break;
        }

        this.pendingStreams.delete(id);

        if (ipcTypeFlag === IpcTypeFlag.InvokeStream) {
          const [responseEvent, payload] = fullContent.split(/ (.*)/);
          void this.invokeListener(listener, responseEvent, payload);
          break;
        }

        void this.callListener(listener, fullContent);

        break;
      }
    }
  }

  private onScriptEventRecieved = (
    e: ScriptEventCommandMessageAfterEvent
  ): void => {
    this.routeEvent(e.id, e.message);
  };
}
