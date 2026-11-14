import { InternalError } from '../../errors/catalog.js';

interface Node<V> {
  key: number;
  value: V;
  left: Node<V> | null;
  right: Node<V> | null;
  height: number;
}

const height = (n: Node<unknown> | null): number => (n ? n.height : 0);
const fix = <V>(n: Node<V>): Node<V> => {
  n.height = 1 + Math.max(height(n.left), height(n.right));
  return n;
};
const rotateRight = <V>(n: Node<V>): Node<V> => {
  const l = n.left!;
  n.left = l.right;
  l.right = fix(n);
  return fix(l);
};
const rotateLeft = <V>(n: Node<V>): Node<V> => {
  const r = n.right!;
  n.right = r.left;
  r.left = fix(n);
  return fix(r);
};
function balance<V>(n: Node<V>): Node<V> {
  fix(n);
  const b = height(n.left) - height(n.right);
  if (b > 1) {
    if (height(n.left!.left) < height(n.left!.right)) n.left = rotateLeft(n.left!);
    return rotateRight(n);
  }
  if (b < -1) {
    if (height(n.right!.right) < height(n.right!.left)) n.right = rotateRight(n.right!);
    return rotateLeft(n);
  }
  return n;
}

/**
 * Keys (job `seq` numbers) in sorted order, as an AVL tree: insert and delete are O(log n) with one
 * comparator call per level, and min/max/pop make no comparator calls.
 */
export class OrderedIndex<V> {
  #root: Node<V> | null = null;
  #size = 0;
  readonly #compare: (a: number, b: number) => number;

  constructor(compare: (a: number, b: number) => number = (a, b) => a - b) {
    this.#compare = compare;
  }

  get size(): number {
    return this.#size;
  }

  insert(key: number, value: V): void {
    this.#root = this.#insert(this.#root, key, value);
    this.#size++;
  }

  delete(key: number): boolean {
    const before = this.#size;
    this.#root = this.#delete(this.#root, key);
    return this.#size < before;
  }

  min(): { key: number; value: V } | undefined {
    let n = this.#root;
    while (n?.left) n = n.left;
    return n ? { key: n.key, value: n.value } : undefined;
  }

  max(): { key: number; value: V } | undefined {
    let n = this.#root;
    while (n?.right) n = n.right;
    return n ? { key: n.key, value: n.value } : undefined;
  }

  popMin(): { key: number; value: V } | undefined {
    if (!this.#root) return undefined;
    let min!: Node<V>;
    this.#root = this.#removeMin(this.#root, (n) => (min = n));
    this.#size--;
    return { key: min.key, value: min.value };
  }

  popMax(): { key: number; value: V } | undefined {
    if (!this.#root) return undefined;
    let max!: Node<V>;
    this.#root = this.#removeMax(this.#root, (n) => (max = n));
    this.#size--;
    return { key: max.key, value: max.value };
  }

  *iterate(dir: 'asc' | 'desc'): IterableIterator<{ key: number; value: V }> {
    const [first, second] = dir === 'asc' ? (['left', 'right'] as const) : (['right', 'left'] as const);
    const stack: Node<V>[] = [];
    let n = this.#root;
    while (n || stack.length) {
      while (n) {
        stack.push(n);
        n = n[first];
      }
      n = stack.pop()!;
      yield { key: n.key, value: n.value };
      n = n[second];
    }
  }

  #insert(n: Node<V> | null, key: number, value: V): Node<V> {
    if (!n) return { key, value, left: null, right: null, height: 1 };
    const c = this.#compare(key, n.key);
    if (c === 0) throw new InternalError(`OrderedIndex: duplicate key ${key}`);
    if (c < 0) n.left = this.#insert(n.left, key, value);
    else n.right = this.#insert(n.right, key, value);
    return balance(n);
  }

  #delete(n: Node<V> | null, key: number): Node<V> | null {
    if (!n) return null;
    const c = this.#compare(key, n.key);
    if (c < 0) n.left = this.#delete(n.left, key);
    else if (c > 0) n.right = this.#delete(n.right, key);
    else {
      this.#size--;
      if (!n.left || !n.right) return n.left ?? n.right;
      // Replace with the in-order successor, found by following pointers (no comparator calls).
      let successor!: Node<V>;
      n.right = this.#removeMin(n.right, (s) => (successor = s));
      successor.left = n.left;
      successor.right = n.right;
      return balance(successor);
    }
    return balance(n);
  }

  #removeMin(n: Node<V>, take: (n: Node<V>) => void): Node<V> | null {
    if (!n.left) {
      take(n);
      return n.right;
    }
    n.left = this.#removeMin(n.left, take);
    return balance(n);
  }

  #removeMax(n: Node<V>, take: (n: Node<V>) => void): Node<V> | null {
    if (!n.right) {
      take(n);
      return n.left;
    }
    n.right = this.#removeMax(n.right, take);
    return balance(n);
  }
}

interface HeapEntry {
  runAt: number;
  id: string;
  n: number;
}

/** Delayed jobs by `runAt` (ties in insertion order), with O(log n) removal by id. */
export class DelayedHeap {
  readonly #heap: HeapEntry[] = [];
  readonly #pos = new Map<string, number>();
  #counter = 0;

  get size(): number {
    return this.#heap.length;
  }

  push(runAt: number, id: string): void {
    this.#heap.push({ runAt, id, n: this.#counter++ });
    this.#pos.set(id, this.#heap.length - 1);
    this.#up(this.#heap.length - 1);
  }

  peek(): { runAt: number; id: string } | undefined {
    const top = this.#heap[0];
    return top ? { runAt: top.runAt, id: top.id } : undefined;
  }

  pop(): { runAt: number; id: string } | undefined {
    const top = this.peek();
    if (top) this.remove(top.id);
    return top;
  }

  remove(id: string): boolean {
    const i = this.#pos.get(id);
    if (i === undefined) return false;
    const last = this.#heap.pop()!;
    this.#pos.delete(id);
    if (i < this.#heap.length) {
      this.#heap[i] = last;
      this.#pos.set(last.id, i);
      this.#up(i);
      this.#down(i);
    }
    return true;
  }

  #less(a: HeapEntry, b: HeapEntry): boolean {
    return a.runAt < b.runAt || (a.runAt === b.runAt && a.n < b.n);
  }

  #swap(i: number, j: number): void {
    const h = this.#heap;
    [h[i], h[j]] = [h[j]!, h[i]!];
    this.#pos.set(h[i]!.id, i);
    this.#pos.set(h[j]!.id, j);
  }

  #up(i: number): void {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(this.#heap[i]!, this.#heap[p]!)) return;
      this.#swap(i, p);
      i = p;
    }
  }

  #down(i: number): void {
    for (;;) {
      const l = 2 * i + 1;
      const r = l + 1;
      let m = i;
      if (l < this.#heap.length && this.#less(this.#heap[l]!, this.#heap[m]!)) m = l;
      if (r < this.#heap.length && this.#less(this.#heap[r]!, this.#heap[m]!)) m = r;
      if (m === i) return;
      this.#swap(i, m);
      i = m;
    }
  }
}
