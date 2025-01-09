import {
  InvokeOptions,
  IpcTypeFlag,
  ScriptEventListener,
  SendOptions,
  SerializableValue,
} from "./common.js";
import { send, sendInternal, sendStream, sendStreamInternal } from "./send.js";
import { Failure } from "./failure.js";
import { ScriptEventCommandMessageAfterEvent, system } from "@minecraft/server";
import {
  invoke,
  invokeInternal,
  invokeStream,
  invokeStreamInternal,
} from "./invoke.js";
import { MAX_MESSAGE_LENGTH, MAX_ROUTER_UID_LENGTH } from "./constants.js";

/**
 * An IPC router. This must be constructed to recieve IPC events.
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
   * total number of uids generated by this router, used to create stream IDs and unique listener IDs for invoke responses
   */
  private uidsGenerated = 0;

  /**
   * @throws Throws if the UID is invalid.
   */
  constructor(
    /**
     * A **unique** ID for this router. If another router has the same ID, it may cause problems.
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
   * @param event The event ID.
   * @param callback The callback.
   * @throws Throws if another listener is registered for `event`.
   */
  registerListener(event: string, callback: ScriptEventListener): void {
    if (this.listeners.has(event)) {
      throw new Error(
        `can't register listener for event '${event}': a listener for this event has already been registered`
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
    return invoke(options, this, this.generateListenerUid());
  }

  /**
   * Stream a two-way IPC event. The payload has no max length since it is streamed.
   * @returns Returns whatever the listener returns.
   * @throws Throws if a response is not recieved within 20 game ticks (after the entire payload has been streamed).
   * @throws Throws if the message is too long.
   */
  invokeStream(options: InvokeOptions): Promise<SerializableValue> {
    return invokeStream(
      options,
      this,
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

    if (serialized.length > MAX_MESSAGE_LENGTH) {
      return invokeStreamInternal(
        { ...options, payload: serialized },
        this,
        responseListenerId,
        this.generateStreamUid()
      );
    }
    return invokeInternal(
      { ...options, payload: serialized },
      this,
      responseListenerId
    );
  }

  private generateListenerUid(): string {
    return `${this.uid}:l${(this.uidsGenerated++).toString()}`;
  }

  private generateStreamUid(): string {
    return this.uid + (this.uidsGenerated++).toString();
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

  private invokeListener(
    listener: ScriptEventListener,
    responseEvent: string,
    rawPayload: string
  ): void {
    const payload = this.parseRawPayload(rawPayload);

    let response: SerializableValue = null;
    let err;

    try {
      response = listener(payload);
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

  private callListener(
    listener: ScriptEventListener,
    rawPayload: string
  ): void {
    const payload = this.parseRawPayload(rawPayload);
    const result = listener(payload);
    if (result instanceof Failure) {
      console.warn(result);
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
        this.callListener(listener, message);
        break;

      case IpcTypeFlag.Invoke: {
        const [responseEvent, payload] = message.split(/ (.*)/);
        this.invokeListener(listener, responseEvent, payload);
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
          this.invokeListener(listener, responseEvent, payload);
          break;
        }

        this.callListener(listener, fullContent);

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
