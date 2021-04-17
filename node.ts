import { assert } from "https://deno.land/std@0.93.0/_util/assert.ts";
import { equal } from "./lib/fast-deep-equal/mod.ts";

enum Types {
  STATIC = 1,
  PARAM = 2,
  MATCH_ALL = 3,
  REGEX = 4,
  MULTI_PARAM = 5,
}


type Children = Record<string, Node>;
type Store = unknown

interface Handler {
  handler: Function
  params: unknown[]
  constraints: Record<string, unknown>
  store: Store
  paramsLength: number
}

interface NodeOptions {
  prefix?: string;
  method?: string;
  handlers?: Handler[];
  unconstrainedHandler?: Handler | null;
  children?: Children;
  kind?: Types;
  regex?: RegExp | null;
  constrainer?: unknown;
  hasConstraints?: boolean;
}

export class Node {
  prefix: string;
  label: string;
  method?: string;
  handlers: Handler[];
  unconstrainedHandler: Handler | null;
  children: Children;
  numberOfChildren: number;
  kind: Types;
  regex: RegExp | null;
  wildcardChild: Node | null;
  parametricBrother: unknown;
  constrainer?: unknown;
  hasConstraints: boolean;
  constrainedHandlerStores: unknown;

  constructor(options: NodeOptions = {}) {
    this.prefix = options.prefix || "/";
    this.label = this.prefix[0];
    this.method = options.method;
    this.handlers = options.handlers || [];
    this.unconstrainedHandler = options.unconstrainedHandler || null;
    this.children = options.children || {};
    this.numberOfChildren = Object.keys(this.children).length;
    this.kind = options.kind || Types.STATIC;
    this.regex = options.regex || null;
    this.wildcardChild = null;
    this.parametricBrother = null;
    this.constrainer = options.constrainer;
    this.hasConstraints = options.hasConstraints || false;
    this.constrainedHandlerStores = null;
  }

  getLabel(): string {
    return this.prefix[0];
  }

  addChild(node: Node): Node {
    var label = "";
    switch (node.kind) {
      case Types.STATIC:
        label = node.getLabel();
        break;
      case Types.PARAM:
      case Types.REGEX:
      case Types.MULTI_PARAM:
        label = ":";
        break;
      case Types.MATCH_ALL:
        this.wildcardChild = node;
        label = "*";
        break;
      default:
        throw new Error(`Unknown node kind: ${node.kind}`);
    }

    assert(
      this.children[label] === undefined,
      `There is already a child with label '${label}'`,
    );

    this.children[label] = node;
    this.numberOfChildren = Object.keys(this.children).length;

    const labels = Object.keys(this.children);
    var parametricBrother = this.parametricBrother;
    for (var i = 0; i < labels.length; i++) {
      const child = this.children[labels[i]];
      if (child.label === ":") {
        parametricBrother = child;
        break;
      }
    }

    // Save the parametric brother inside static children
    const iterate = (node: Node) => {
      if (!node) {
        return;
      }

      if (node.kind !== Types.STATIC) {
        return;
      }

      if (node !== this) {
        node.parametricBrother = parametricBrother || node.parametricBrother;
      }

      const labels = Object.keys(node.children);
      for (var i = 0; i < labels.length; i++) {
        iterate(node.children[labels[i]]);
      }
    };

    iterate(this);

    return this;
  }

  reset(prefix: string): Node {
    this.prefix = prefix;
    this.children = {};
    this.handlers = [];
    this.unconstrainedHandler = null;
    this.kind = Types.STATIC;
    this.numberOfChildren = 0;
    this.regex = null;
    this.wildcardChild = null;
    this.hasConstraints = false;
    this._decompileGetHandlerMatchingConstraints();
    return this;
  }

  split(length: number): Node {
    const newChild = new Node(
      {
        prefix: this.prefix.slice(length),
        children: this.children,
        kind: this.kind,
        method: this.method,
        handlers: this.handlers.slice(0),
        regex: this.regex,
        constrainer: this.constrainer,
        hasConstraints: this.hasConstraints,
        unconstrainedHandler: this.unconstrainedHandler,
      },
    );
  
    if (this.wildcardChild !== null) {
      newChild.wildcardChild = this.wildcardChild;
    }
  
    this.reset(this.prefix.slice(0, length));
    this.addChild(newChild);
    return newChild;
  }

  findByLabel(path: string) {
    return this.children[path[0]];
  }

  findMatchingChild(derivedConstraints: unknown, path: string) {
    var child = this.children[path[0]];
    if (
      child !== undefined &&
      (child.numberOfChildren > 0 ||
        child.getMatchingHandler(derivedConstraints) !== null)
    ) {
      if (path.slice(0, child.prefix.length) === child.prefix) {
        return child;
      }
    }
  
    child = this.children[":"];
    if (
      child !== undefined &&
      (child.numberOfChildren > 0 ||
        child.getMatchingHandler(derivedConstraints) !== null)
    ) {
      return child;
    }
  
    child = this.children["*"];
    if (
      child !== undefined &&
      (child.numberOfChildren > 0 ||
        child.getMatchingHandler(derivedConstraints) !== null)
    ) {
      return child;
    }
  
    return null;
  }

  addHandler(handler: Function, params: unknown[], store: Store, constraints: Record<string, unknown>) {
    if (!handler) return;
    assert(
      !this.getHandler(constraints),
      `There is already a handler with constraints '${
        JSON.stringify(constraints)
      }' and method '${this.method}'`,
    );
  
    const handlerObject: Handler = {
      handler: handler,
      params: params,
      constraints: constraints,
      store: store || null,
      paramsLength: params.length,
    };
  
    this.handlers.push(handlerObject);
    // Sort the most constrained handlers to the front of the list of handlers so they are tested first.
    this.handlers.sort((a, b) =>
      Object.keys(a.constraints).length - Object.keys(b.constraints).length
    );
  
    if (Object.keys(constraints).length > 0) {
      this.hasConstraints = true;
    } else {
      this.unconstrainedHandler = handlerObject;
    }
  
    if (this.hasConstraints && this.handlers.length > 32) {
      throw new Error(
        "find-my-way supports a maximum of 32 route handlers per node when there are constraints, limit reached",
      );
    }
  
    // Note that the fancy constraint handler matcher needs to be recompiled now that the list of handlers has changed
    // This lazy compilation means we don't do the compile until the first time the route match is tried, which doesn't waste time re-compiling every time a new handler is added
    this._decompileGetHandlerMatchingConstraints();
  }

  getHandler(constraints: unknown): unknown {
    return this.handlers.filter((handler) =>
      equal(constraints, handler.constraints)
    )[0];
  }

  getMatchingHandler(derivedConstraints: unknown): unknown {
    if (this.hasConstraints) {
      // This node is constrained, use the performant precompiled constraint matcher
      return this._getHandlerMatchingConstraints(derivedConstraints);
    } else {
      // This node doesn't have any handlers that are constrained, so it's handlers probably match. Some requests have constraint values that *must* match however, like version, so check for those before returning it.
      if (derivedConstraints && derivedConstraints.__hasMustMatchValues) {
        return null;
      } else {
        return this.unconstrainedHandler;
      }
    }
  };

  _getHandlerMatchingConstraints: Function = compileThenGetHandlerMatchingConstraints

  _decompileGetHandlerMatchingConstraints() {
    this._getHandlerMatchingConstraints =
      compileThenGetHandlerMatchingConstraints;
    return null;
  };

  _buildConstraintStore(constraint: unknown): unknown {
    const store = this.constrainer.newStoreForConstraint(constraint);
  
    for (let i = 0; i < this.handlers.length; i++) {
      const handler = this.handlers[i];
      const mustMatchValue = handler.constraints[constraint];
      if (typeof mustMatchValue !== "undefined") {
        let indexes = store.get(mustMatchValue);
        if (!indexes) {
          indexes = 0;
        }
        indexes |= 1 << i; // set the i-th bit for the mask because this handler is constrained by this value https://stackoverflow.com/questions/1436438/how-do-you-set-clear-and-toggle-a-single-bit-in-javascrip
        store.set(mustMatchValue, indexes);
      }
    }
  
    return store;
  };

  _constrainedIndexBitmask(constraint: unknown): number {
    let mask = 0b0;
    for (let i = 0; i < this.handlers.length; i++) {
      const handler = this.handlers[i];
      if (handler.constraints && constraint in handler.constraints) {
        mask |= 1 << i;
      }
    }
    return ~mask;
  };

  _compileGetHandlerMatchingConstraints() {
    this.constrainedHandlerStores = {};
    let constraints: Set<string> | string[] = new Set();
    for (const handler of this.handlers) {
      for (const key of Object.keys(handler.constraints)) {
        constraints.add(key);
      }
    }
    constraints = Array.from(constraints);
    const lines = [];
  
    // always check the version constraint first as it is the most selective
    constraints.sort((a, b) => a === "version" ? 1 : 0);
  
    for (const constraint of constraints) {
      this.constrainedHandlerStores[constraint] = this._buildConstraintStore(
        constraint,
      );
    }
  
    lines.push(`
    let candidates = 0b${"1".repeat(this.handlers.length)}
    let mask, matches
    `);
    for (const constraint of constraints) {
      // Setup the mask for indexes this constraint applies to. The mask bits are set to 1 for each position if the constraint applies.
      lines.push(`
      mask = ${this._constrainedIndexBitmask(constraint)}
      value = derivedConstraints.${constraint}
      `);
  
      // If there's no constraint value, none of the handlers constrained by this constraint can match. Remove them from the candidates.
      // If there is a constraint value, get the matching indexes bitmap from the store, and mask it down to only the indexes this constraint applies to, and then bitwise and with the candidates list to leave only matching candidates left.
      lines.push(`
      if (typeof value === "undefined") {
        candidates &= mask
      } else {
        matches = this.constrainedHandlerStores.${constraint}.get(value) || 0
        candidates &= (matches | mask)
      }
      if (candidates === 0) return null;
      `);
    }
    // Return the first handler who's bit is set in the candidates https://stackoverflow.com/questions/18134985/how-to-find-index-of-first-set-bit
    lines.push(`
    return this.handlers[Math.floor(Math.log2(candidates))]
    `);
  
    this._getHandlerMatchingConstraints = new Function(
      "derivedConstraints",
      lines.join("\n"),
    ); // eslint-disable-line
  };
  
}


// We compile the handler matcher the first time this node is matched. We need to recompile it if new handlers are added, so when a new handler is added, we reset the handler matching function to this base one that will recompile it.
function compileThenGetHandlerMatchingConstraints(this: Node, derivedConstraints: unknown): unknown {
  this._compileGetHandlerMatchingConstraints();
  return this._getHandlerMatchingConstraints(derivedConstraints);
}