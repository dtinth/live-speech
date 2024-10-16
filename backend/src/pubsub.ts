type Listener = (message: string) => void;

class PubSub {
  private listenerSetMap = new Map<string, Set<Listener>>();

  getListenerSet(channel: string): Set<Listener> {
    if (!this.listenerSetMap.has(channel)) {
      this.listenerSetMap.set(channel, new Set());
    }
    return this.listenerSetMap.get(channel)!;
  }

  subscribe(channel: string, listener: Listener): () => void {
    const listeners = this.getListenerSet(channel);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  publish(channel: string, method: string, params: any): void {
    const payload = JSON.stringify({ method, params });
    const listeners = this.getListenerSet(channel);
    for (const listener of listeners) {
      try {
        listener(payload);
      } catch (error) {
        console.error(error);
      }
    }
  }
}

export const pubsub = new PubSub();
