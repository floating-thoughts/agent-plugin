// Generated from the service contract; do not edit by hand (a test checks it is current).

export type ToolSpec = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export const CONTRACT_SHA256 = "aec6987299b6a055a9c4665565631f4a848480586e877143931bde56a722221f"

export const API = "svc/1" as const
export const PREFIX = "/svc/v1" as const
export const BODY_LIMIT = 65536 as const
export const OUTER_PATH = "/svc/v1/x" as const
export const OUTER_LOGIN_PATH = "/svc/v1/auth/login/x" as const
export const E2E_ENCODINGS = ["binary", "base64"] as const
export const E2E_CONTENT_TYPE_B64 = "application/x-agent-e2e-b64" as const
export const E2E_ENCODING_HEADER = "X-Agent-E2E-Encoding" as const
export const E2E_ENCODING_B64 = "b64" as const
export const E2E_B64_BODY_LIMIT = 87384 as const
export const OUTBOX_FOLDER = "<data dir>/services/outbox/" as const
export const OUTBOX_PATH = "<data dir>/services/outbox/<day>-<session 8 hex>.jsonl" as const
export const OUTBOX_KEEP_DAYS = 90 as const
export const TOOL_NAMES = ["router_advice", "lesson_lookup", "savings", "checkpoint_advice", "status"] as const

// x-tools: the tools the hooks module registers (schemas and descriptions, in order)
export const TOOLS: readonly ToolSpec[] = [
  {
    "name": "router_advice",
    "description": "Ask the routing service which model and effort a subagent dispatch should use. Sends the service only the first word of the description (at most 32 characters) and its length, the subagent type, the requested model and effort, the harness name, a random session ref, the dispatch count in this session and a salted project hash, and, when known, the main model name, whether the user asked for a review, whether strict routing is on and the optional scope; the description text stays on this machine. The 100,000 limit is the local input limit. Returns the decision (route, pass or deny), the model, the effort, a hint, and brief_rule, a speed-up suggestion the plugin itself adds, labelled, to each dispatched subagent brief (do not copy it); pass_through when the service cannot be reached. On a plan, replan or acceptance dispatch, pass scope (the planned work's shape as counts and flags, no text) to get a project size in hint.",
    "input_schema": {
      "type": "object",
      "properties": {
        "subagent_type": {
          "type": "string",
          "minLength": 1,
          "maxLength": 64
        },
        "description": {
          "type": "string",
          "maxLength": 100000
        },
        "model": {
          "type": [
            "string",
            "null"
          ]
        },
        "effort": {
          "type": [
            "string",
            "null"
          ]
        },
        "scope": {
          "type": "object",
          "properties": {
            "kind": {
              "type": "string",
              "enum": [
                "code",
                "oneoff_fix",
                "ops_content",
                "script",
                "other"
              ]
            },
            "in_git": {
              "type": "boolean"
            },
            "requirements_clear": {
              "type": "boolean"
            },
            "testable": {
              "type": "boolean"
            },
            "files_expected": {
              "type": "integer",
              "minimum": 0,
              "maximum": 100000
            },
            "sessions_expected": {
              "type": "integer",
              "minimum": 0,
              "maximum": 1000
            },
            "modules_expected": {
              "type": "integer",
              "minimum": 0,
              "maximum": 1000
            },
            "unfamiliar_codebase": {
              "type": "boolean"
            }
          },
          "additionalProperties": false
        }
      },
      "required": [
        "subagent_type",
        "description"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "lesson_lookup",
    "description": "Fetch the served lessons for a role and a work phase (plan, implement, test, review, deliver, checkpoint). Returns the version, the catalog line, the items and the rule for using them; an empty list when nothing is served.",
    "input_schema": {
      "type": "object",
      "properties": {
        "role": {
          "type": "string",
          "enum": [
            "control",
            "auto",
            "plugin"
          ]
        },
        "phase": {
          "type": "string",
          "enum": [
            "plan",
            "implement",
            "test",
            "review",
            "deliver",
            "checkpoint"
          ]
        }
      },
      "required": [
        "role",
        "phase"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "savings",
    "description": "Show what the agent services saved so far: the estimated dollars saved by routing subagents to cheaper models (compared with running them on Opus), by checkpoint compactions and by indexed file reads, worked out by the service from the daily usage summaries of the local savings log. Returns local_only when the service cannot be reached.",
    "input_schema": {
      "type": "object",
      "properties": {},
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "checkpoint_advice",
    "description": "Ask whether now is a good moment for a checkpoint, given how full the context is and what was done since the last one. Returns now (true or false) and the lines to keep in the summary. Pass event when a work event prompted the question (module_done, topic_switch, milestone, user_request).",
    "input_schema": {
      "type": "object",
      "properties": {
        "context_pct": {
          "type": "number",
          "minimum": 0,
          "maximum": 100
        },
        "turns": {
          "type": "integer",
          "minimum": 0
        },
        "tool_calls": {
          "type": "integer",
          "minimum": 0
        },
        "todos_done": {
          "type": "integer",
          "minimum": 0
        },
        "commits": {
          "type": "integer",
          "minimum": 0
        },
        "minutes": {
          "type": "integer",
          "minimum": 0
        },
        "event": {
          "type": "string",
          "enum": [
            "module_done",
            "topic_switch",
            "milestone",
            "user_request"
          ]
        }
      },
      "required": [
        "context_pct"
      ],
      "additionalProperties": false
    }
  },
  {
    "name": "status",
    "description": "Whether agent-services is active in this session, and what to do if it is not (sign in, update the plugin, or wait for the server).",
    "input_schema": {
      "type": "object",
      "properties": {},
      "additionalProperties": false
    }
  }
]

// the whole public contract
export const CONTRACT = {
 "api": "svc/1",
 "prefix": "/svc/v1",
 "source": "Request contract between the local connector (host/services.py) and our service: the client builds requests and checks replies against this file, and the server accepts requests by it",
 "x-transport": {
  "scheme": "https",
  "tls_min": "1.2",
  "endpoint": "Endpoint in the client config: https://<IPv4>:<port> (direct over a private network, the server's own certificate) or https://<hostname>[:<port>] (a TLS-terminating tunnel such as Cloudflare Tunnel)",
  "trust": "IPv4 endpoint: trust only the certificate SHA-256 fingerprint pinned in the client config (pin kind cert_sha256), not the system trust store. Hostname endpoint: the system trust store plus the hostname check (pin kind ca), and both server_keys and e2e_keys are required, so a TLS-terminating edge can neither forge an answer nor read a credential or served content. Never fall back to plaintext: with e2e_keys set, a request that cannot be sealed is not sent",
  "response_signature": "With server_keys in the client config, every answer must carry X-Agent-Server-Signature: v=1; kid=<16 hex: sha256(raw public key)[:16]>; ts=<unix seconds>; sig=<base64 Ed25519 signature> over the UTF-8 lines agent-svc-response/1, status, METHOD, path without query, the request's X-Agent-Challenge (32 hex, fresh per request), ts, sha256 hex of the body bytes, joined by a newline. The client refuses an answer that is unsigned, signed by a key not in server_keys, bound to another request (replay) or more than 300 seconds off its clock, never uses it, and closes the shell gate (reason unverified); an unsigned 5xx, 403 or 429 (the tunnel edge's own page) counts as an unreachable server and is backed off (an unsigned Retry-After is honored up to 60 seconds); with e2e_keys, a signed success that is not a sealed answer, or one that does not open, is never used either. Verifier: host/services.py _verify_response",
  "egress": "Only the plugin's hooks module sends (its svc channel, inside the Claude Code process); sessions, other hooks, other plugins, tools and the UI never connect to the service directly. Until the migration release the Python client (the local connector process, host/services.py) is the one sender instead",
  "e2e": {
   "envelope": "End-to-end envelope (host/e2e.py, both sides), used for every request but GET /health whenever the client config has e2e_keys (required for a hostname endpoint, optional for the IPv4 one). The client makes a fresh X25519 key per request; shared = X25519(that key, the first key in e2e_keys); HKDF-SHA256(shared, salt agent-svc-e2e/1, info \"keys\" + ephemeral public key + server public key) gives 64 bytes: the request key (first 32) and the answer key (last 32). Outer request: POST to an outer path (x-transport outer_paths) with X-Agent-E2E: v=1; kid=<16 hex: sha256(raw X25519 public key)[:16]>; epk=<base64 ephemeral public key>; ts=<unix seconds>, X-Agent-Challenge and Content-Type application/octet-stream; body = 12-byte nonce || AES-256-GCM(request key, inner, aad). Inner: compact JSON {method, path (with query), headers} + newline + the raw body; the headers are the credential headers (Authorization, X-Agent-Account, X-Agent-Device, X-Agent-Claude, X-Agent-Timestamp, X-Agent-Nonce, X-Agent-Signature) and Content-Type, which never travel outside the envelope. AAD: the lines agent-svc-e2e/1, req (or resp), POST, the outer path, kid, epk, ts, challenge. Answer: 200 application/octet-stream, body = random 12-byte nonce || AES-256-GCM(answer key, compact JSON {status, headers} + newline + body, aad with resp); errors found before the envelope opens (limits, bad_envelope) are plain JSON. The server refuses a timestamp more than 300 seconds off, an unknown kid (before any key work), an envelope that does not open, a login route outside the login outer path, and a replayed ephemeral key, all as 400 bad_envelope counted as a failed authentication of the client IP; one that opens but is stamped before the server's start is 503 restarted (Retry-After), not counted. The Ed25519 response signature covers the outer answer (the ciphertext), so a client checks it before decrypting and a signature never confirms a guess about the plaintext",
   "encodings": [
    "binary",
    "base64"
   ],
   "base64": "Base64 variant, for a client whose only network call carries text (the plugin's hooks module); the binary form in envelope stays for the Python client. Flag: a request whose Content-Type media type is application/x-agent-e2e-b64 (parameters ignored), or that carries the header X-Agent-E2E-Encoding: b64 (for an engine that overrides Content-Type); anything else is binary. Request body: standard base64 (RFC 4648 section 4, padded, no whitespace, canonical) of exactly the binary body, decoded strictly; a body that does not decode is the same 400 bad_envelope, counted alike. Size: the outer read limit is 87384 bytes (4 * ceil(65536 / 3)) and the decoded body must still be at most 65536 bytes, else 413 too_large. Answer: when the request was base64, the sealed answer is base64 of the binary answer, outer status 200, Content-Type application/x-agent-e2e-b64; the response signature covers the bytes sent (the base64 ASCII, equal to the UTF-8 bytes of the answer text). Errors found before the envelope opens stay plain ASCII JSON, signed. Keys, AAD, frames, outer paths, the replay cache and the per-IP budgets are the same for both encodings; the encoding is not bound into the AAD, since changing it in transit only makes the open fail",
   "base64_flag": {
    "content_type": "application/x-agent-e2e-b64",
    "header": "X-Agent-E2E-Encoding",
    "header_value": "b64"
   },
   "base64_body_bytes": 87384
  },
  "outer_paths": {
   "POST /svc/v1/x": "every sealed route except the two login routes",
   "POST /svc/v1/auth/login/x": "sealed login start and finish (keeps the edge's per-IP login rate rule)",
   "GET /health": "plain; carries no credential or private content"
  }
 },
 "x-auth": {
  "header": "Authorization",
  "format": "Bearer <client_id>.<secret>",
  "note": "One service key per client (we issue it); stored at <data dir>/secrets/services.key, readable by the current user only; never in logs, events, the outbox or error text; unrelated to Claude credentials"
 },
 "x-headers": [
  {
   "name": "Authorization",
   "value": "service key (see x-auth)",
   "in_outbox": false
  },
  {
   "name": "User-Agent",
   "value": "agent-services/<client_version>",
   "in_outbox": true
  },
  {
   "name": "Content-Type",
   "value": "application/json",
   "in_outbox": true
  },
  {
   "name": "X-Agent-Challenge",
   "value": "32 random lowercase hex per request, sent only when the client config has server_keys; the server signs its answer over it (x-transport response_signature)",
   "in_outbox": false
  },
  {
   "name": "X-Agent-E2E",
   "value": "v=1; kid=<16 hex>; epk=<base64 32-byte X25519 public key>; ts=<unix seconds>, sent only when the client config has e2e_keys (x-transport e2e); the credential headers then travel inside the envelope only",
   "in_outbox": false
  },
  {
   "name": "X-Agent-E2E-Encoding",
   "value": "b64, sent only by a client that cannot set Content-Type application/x-agent-e2e-b64 (x-transport e2e base64_flag); absent means the Content-Type decides",
   "in_outbox": false
  }
 ],
 "x-validation": "Both ends validate against the request schema: the client builds the body only from the schema and drops fields the schema does not have before sending; the server answers 422 bad_request on extra fields or a wrong type or length; cross-field limits (x-limits) are checked on both ends",
 "limits": {
  "body_bytes": 65536
 },
 "x-common-errors": {
  "400": [
   "bad_json",
   "bad_envelope"
  ],
  "401": [
   "bad_key"
  ],
  "403": [
   "owner_only",
   "e2e_required"
  ],
  "404": [
   "not_found"
  ],
  "413": [
   "too_large"
  ],
  "422": [
   "bad_request"
  ],
  "423": [
   "org_paused"
  ],
  "429": [
   "rate_limited"
  ],
  "500": [
   "internal"
  ],
  "503": [
   "unavailable",
   "busy",
   "restarted"
  ]
 },
 "x-login-check": {
  "route": "POST /auth/login/start",
  "request_field": "check: optional string (at most 100 characters), the token of a passed check",
  "error": {
   "status": 403,
   "code": "check_required",
   "body": {
    "error": "check_required",
    "check_url": "https://<server origin>/check?t=<token>",
    "check": "<token>"
   }
  },
  "when": "only under signs of abuse (server-side rules, not published); never without Turnstile keys and a public base URL",
  "flow": "the person opens check_url (Turnstile widget) and passes it; the client then retries /auth/login/start with {email, check}; a token is single use and lasts 10 minutes"
 },
 "x-client-config": {
  "path": "<data dir>/services/client.json (absent: the shipped host/client_defaults.json; written by the Python client's staging setup, from what the operator gives: endpoint, server keys and e2e keys; the server's admin CLI prints them (server-key))",
  "schema": {
   "type": "object",
   "properties": {
    "endpoint": {
     "type": "string",
     "pattern": "^https://((\\d{1,3}\\.){3}\\d{1,3}:\\d{1,5}|((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(:\\d{1,5})?)$",
     "maxLength": 270,
     "description": "https://<IPv4>:<port> (pin cert_sha256) or https://<hostname>[:<port>] (pin ca)"
    },
    "client_id": {
     "type": "string",
     "pattern": "^c_[a-z0-9]{8,32}$",
     "maxLength": 34
    },
    "pin": {
     "type": "object",
     "properties": {
      "kind": {
       "enum": [
        "cert_sha256",
        "ca"
       ]
      },
      "sha256": {
       "type": "array",
       "minItems": 1,
       "maxItems": 2,
       "items": {
        "type": "string",
        "pattern": "^[0-9a-f]{64}$",
        "maxLength": 64
       },
       "description": "two fingerprints: the old and the new certificate are both accepted during rotation"
      }
     },
     "required": [
      "kind"
     ],
     "additionalProperties": false
    },
    "server_keys": {
     "type": "array",
     "minItems": 1,
     "maxItems": 2,
     "uniqueItems": true,
     "items": {
      "type": "string",
      "pattern": "^[A-Za-z0-9+/]{43}=$",
      "maxLength": 44
     },
     "description": "the server's Ed25519 public keys (raw 32 bytes, base64) that sign every answer; two only while the server rotates its key"
    },
    "e2e_keys": {
     "type": "array",
     "minItems": 1,
     "maxItems": 2,
     "uniqueItems": true,
     "items": {
      "type": "string",
      "pattern": "^[A-Za-z0-9+/]{43}=$",
      "maxLength": 44
     },
     "description": "the server's X25519 public keys (raw 32 bytes, base64) that requests are sealed to (x-transport e2e; the first is used); two only while the server rotates its key; needs server_keys"
    }
   },
   "required": [
    "endpoint",
    "pin"
   ],
   "additionalProperties": false,
   "anyOf": [
    {
     "type": "object",
     "description": "direct: the server's own self-signed certificate is pinned; server_keys optional; e2e_keys optional (needs server_keys)",
     "properties": {
      "endpoint": {
       "type": "string",
       "pattern": "^https://(\\d{1,3}\\.){3}\\d{1,3}:\\d{1,5}$",
       "maxLength": 40
      },
      "client_id": {
       "type": "string",
       "pattern": "^c_[a-z0-9]{8,32}$",
       "maxLength": 34
      },
      "pin": {
       "type": "object",
       "properties": {
        "kind": {
         "const": "cert_sha256"
        },
        "sha256": {
         "type": "array",
         "minItems": 1,
         "maxItems": 2,
         "items": {
          "type": "string",
          "pattern": "^[0-9a-f]{64}$",
          "maxLength": 64
         },
         "description": "two fingerprints: the old and the new certificate are both accepted during rotation"
        }
       },
       "required": [
        "kind",
        "sha256"
       ],
       "additionalProperties": false
      },
      "server_keys": {
       "type": "array",
       "minItems": 1,
       "maxItems": 2,
       "uniqueItems": true,
       "items": {
        "type": "string",
        "pattern": "^[A-Za-z0-9+/]{43}=$",
        "maxLength": 44
       },
       "description": "the server's Ed25519 public keys (raw 32 bytes, base64) that sign every answer; two only while the server rotates its key"
      },
      "e2e_keys": {
       "type": "array",
       "minItems": 1,
       "maxItems": 2,
       "uniqueItems": true,
       "items": {
        "type": "string",
        "pattern": "^[A-Za-z0-9+/]{43}=$",
        "maxLength": 44
       },
       "description": "the server's X25519 public keys (raw 32 bytes, base64) that requests are sealed to (x-transport e2e; the first is used); two only while the server rotates its key; needs server_keys"
      }
     },
     "required": [
      "endpoint",
      "pin"
     ],
     "additionalProperties": false
    },
    {
     "type": "object",
     "description": "tunnel: system trust store and hostname check, every answer signed by one of server_keys and every request but GET /health sealed to e2e_keys (no plaintext fallback)",
     "properties": {
      "endpoint": {
       "type": "string",
       "pattern": "^https://((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)*[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)(:\\d{1,5})?$",
       "maxLength": 270
      },
      "client_id": {
       "type": "string",
       "pattern": "^c_[a-z0-9]{8,32}$",
       "maxLength": 34
      },
      "pin": {
       "type": "object",
       "properties": {
        "kind": {
         "const": "ca"
        }
       },
       "required": [
        "kind"
       ],
       "additionalProperties": false
      },
      "server_keys": {
       "type": "array",
       "minItems": 1,
       "maxItems": 2,
       "uniqueItems": true,
       "items": {
        "type": "string",
        "pattern": "^[A-Za-z0-9+/]{43}=$",
        "maxLength": 44
       },
       "description": "the server's Ed25519 public keys (raw 32 bytes, base64) that sign every answer; two only while the server rotates its key"
      },
      "e2e_keys": {
       "type": "array",
       "minItems": 1,
       "maxItems": 2,
       "uniqueItems": true,
       "items": {
        "type": "string",
        "pattern": "^[A-Za-z0-9+/]{43}=$",
        "maxLength": 44
       },
       "description": "the server's X25519 public keys (raw 32 bytes, base64) that requests are sealed to (x-transport e2e; the first is used); two only while the server rotates its key; needs server_keys"
      }
     },
     "required": [
      "endpoint",
      "pin",
      "server_keys",
      "e2e_keys"
     ],
     "additionalProperties": false
    }
   ]
  }
 },
 "x-outbox": {
  "path": "<data dir>/services/outbox/<day>-<session 8 hex>.jsonl",
  "folder": "<data dir>/services/outbox/",
  "line": {
   "$ref": "#/definitions/OutboxLine"
  },
  "kinds": {
   "tool": {
    "$ref": "#/definitions/OutboxToolLine"
   },
   "artifact_publish": {
    "$ref": "#/definitions/OutboxPublishLine"
   },
   "cap": {
    "$ref": "#/definitions/OutboxCapLine"
   }
  },
  "keep_days": 90,
  "note": "one line per request, including previews that are never sent (preview=true, status=null); body_text is the exact bytes of the request body that was sent (UTF-8), without the Authorization header; one file per Claude Code session and UTC day (<day> is YYYY-MM-DD, <session 8 hex> the first 8 hex of the session id), buffered in memory and rewritten whole at most every 5 seconds and at session end, at most 2 MiB per file, files older than keep_days swept at session start; each call the model makes to our tools (name and arguments) is logged too, and each dashboard publish attempt; a line with a kind field is not a request and follows the schema kinds names for it (tool, artifact_publish, cap), every other line is an OutboxLine, whose outer_path and outer_bytes give the sealed request as sent. Until the migration release the Python client writes <data dir>/services/outbox.jsonl instead"
 },
 "x-tools": [
  {
   "name": "router_advice",
   "description": "Ask the routing service which model and effort a subagent dispatch should use. Sends the service only the first word of the description (at most 32 characters) and its length, the subagent type, the requested model and effort, the harness name, a random session ref, the dispatch count in this session and a salted project hash, and, when known, the main model name, whether the user asked for a review, whether strict routing is on and the optional scope; the description text stays on this machine. The 100,000 limit is the local input limit. Returns the decision (route, pass or deny), the model, the effort, a hint, and brief_rule, a speed-up suggestion the plugin itself adds, labelled, to each dispatched subagent brief (do not copy it); pass_through when the service cannot be reached. On a plan, replan or acceptance dispatch, pass scope (the planned work's shape as counts and flags, no text) to get a project size in hint.",
   "input_schema": {
    "type": "object",
    "properties": {
     "subagent_type": {
      "type": "string",
      "minLength": 1,
      "maxLength": 64
     },
     "description": {
      "type": "string",
      "maxLength": 100000
     },
     "model": {
      "type": [
       "string",
       "null"
      ]
     },
     "effort": {
      "type": [
       "string",
       "null"
      ]
     },
     "scope": {
      "type": "object",
      "properties": {
       "kind": {
        "type": "string",
        "enum": [
         "code",
         "oneoff_fix",
         "ops_content",
         "script",
         "other"
        ]
       },
       "in_git": {
        "type": "boolean"
       },
       "requirements_clear": {
        "type": "boolean"
       },
       "testable": {
        "type": "boolean"
       },
       "files_expected": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "sessions_expected": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000
       },
       "modules_expected": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000
       },
       "unfamiliar_codebase": {
        "type": "boolean"
       }
      },
      "additionalProperties": false
     }
    },
    "required": [
     "subagent_type",
     "description"
    ],
    "additionalProperties": false
   }
  },
  {
   "name": "lesson_lookup",
   "description": "Fetch the served lessons for a role and a work phase (plan, implement, test, review, deliver, checkpoint). Returns the version, the catalog line, the items and the rule for using them; an empty list when nothing is served.",
   "input_schema": {
    "type": "object",
    "properties": {
     "role": {
      "type": "string",
      "enum": [
       "control",
       "auto",
       "plugin"
      ]
     },
     "phase": {
      "type": "string",
      "enum": [
       "plan",
       "implement",
       "test",
       "review",
       "deliver",
       "checkpoint"
      ]
     }
    },
    "required": [
     "role",
     "phase"
    ],
    "additionalProperties": false
   }
  },
  {
   "name": "savings",
   "description": "Show what the agent services saved so far: the estimated dollars saved by routing subagents to cheaper models (compared with running them on Opus), by checkpoint compactions and by indexed file reads, worked out by the service from the daily usage summaries of the local savings log. Returns local_only when the service cannot be reached.",
   "input_schema": {
    "type": "object",
    "properties": {},
    "required": [],
    "additionalProperties": false
   }
  },
  {
   "name": "checkpoint_advice",
   "description": "Ask whether now is a good moment for a checkpoint, given how full the context is and what was done since the last one. Returns now (true or false) and the lines to keep in the summary. Pass event when a work event prompted the question (module_done, topic_switch, milestone, user_request).",
   "input_schema": {
    "type": "object",
    "properties": {
     "context_pct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100
     },
     "turns": {
      "type": "integer",
      "minimum": 0
     },
     "tool_calls": {
      "type": "integer",
      "minimum": 0
     },
     "todos_done": {
      "type": "integer",
      "minimum": 0
     },
     "commits": {
      "type": "integer",
      "minimum": 0
     },
     "minutes": {
      "type": "integer",
      "minimum": 0
     },
     "event": {
      "type": "string",
      "enum": [
       "module_done",
       "topic_switch",
       "milestone",
       "user_request"
      ]
     }
    },
    "required": [
     "context_pct"
    ],
    "additionalProperties": false
   }
  },
  {
   "name": "status",
   "description": "Whether agent-services is active in this session, and what to do if it is not (sign in, update the plugin, or wait for the server).",
   "input_schema": {
    "type": "object",
    "properties": {},
    "additionalProperties": false
   }
  }
 ],
 "x-mcp": {
  "path": "/mcp",
  "transport": "Streamable HTTP, JSON-RPC 2.0 (single messages or a batch): POST /mcp with Content-Type application/json; the answer is application/json (200, or 202 with no body when every message was a notification); no SSE stream and no Mcp-Session-Id; GET, DELETE and other methods answer 405. /mcp, the OAuth paths (x-oauth) and /.well-known/oauth-* take plaintext requests and send unsigned answers (the Codex path through the tunnel, disclosed in the Codex plugin data note); every other path keeps the envelope and the response signature (x-transport).",
  "auth": "Every request, initialize included, carries Authorization: Bearer <OAuth access token> (x-oauth). Without a valid token the answer is 401 with WWW-Authenticate: Bearer resource_metadata=\"<base>/.well-known/oauth-protected-resource/mcp\", where <base> is the limits setting unsubscribe_base_url (the server's public https base). initialize checks the token only: no store write and no outbound call.",
  "protocol_versions": [
   "2025-06-18",
   "2025-03-26",
   "2025-11-25"
  ],
  "instructions": "agent-services: working methods and subagent routing for Codex.\nCall lesson_lookup with a work phase (plan, implement, test, review, deliver, checkpoint) for that phase's methods.",
  "tools": [
   {
    "name": "router_advice",
    "description": "Ask agent-services which model and reasoning_effort a spawn_agent call should use (an agent-services suggestion). Pass task_name as you will give it to spawn_agent: lowercase letters, digits and underscores, starting with a task word (plan, replan, acceptance, review, default, explore) and an underscore. Only the task name is sent; the brief stays on this machine. Without task_name the whole tier table comes back. Returns advice: a sentence naming the model and effort, or null for an unknown task word.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "task_name": {
       "type": "string",
       "pattern": "^[a-z0-9_]{1,64}$",
       "maxLength": 64
      }
     },
     "additionalProperties": false
    },
    "annotations": {
     "readOnlyHint": true
    }
   },
   {
    "name": "lesson_lookup",
    "description": "Fetch the agent-services working methods for one work phase (plan, implement, test, review, deliver, checkpoint). Returns the version, the catalog line, the items wrapped in <agent-method> and the rule for using them; an empty list when nothing is served. The plan phase also arrives once per thread with the session; call this for the other phases when you reach them.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "role": {
       "type": "string",
       "enum": [
        "codex"
       ]
      },
      "phase": {
       "type": "string",
       "enum": [
        "plan",
        "implement",
        "test",
        "review",
        "deliver",
        "checkpoint"
       ]
      }
     },
     "required": [
      "phase"
     ],
     "additionalProperties": false
    },
    "annotations": {
     "readOnlyHint": true
    }
   },
   {
    "name": "checkpoint_advice",
    "description": "Ask whether now is a good moment to compact the conversation, given how full the context is and what was done since the last compaction. Returns now (true or false) and the lines to keep in the summary. Pass event when a work event prompted the question (module_done, topic_switch, milestone, user_request).",
    "inputSchema": {
     "type": "object",
     "properties": {
      "context_pct": {
       "type": "number",
       "minimum": 0,
       "maximum": 100
      },
      "turns": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      "tool_calls": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      "todos_done": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      "commits": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      "minutes": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      "event": {
       "type": "string",
       "enum": [
        "module_done",
        "topic_switch",
        "milestone",
        "user_request"
       ]
      }
     },
     "required": [
      "context_pct"
     ],
     "additionalProperties": false
    },
    "annotations": {
     "readOnlyHint": true
    }
   },
   {
    "name": "status",
    "description": "Whether agent-services is active for this Codex sign-in: signed in, the license state, whether the company paused the service, and the methods choice. When the agent-services tools are not available at all, the sign-in is missing or expired: the user runs `codex mcp login agent-services`.",
    "inputSchema": {
     "type": "object",
     "properties": {},
     "additionalProperties": false
    },
    "annotations": {
     "readOnlyHint": true
    }
   },
   {
    "name": "setup",
    "description": "Read what agent-services does, changing nothing: \"methods preview\" returns the methods text the session hooks add once per thread; \"info hooks\" lists the plugin hooks and what each one sends.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "command": {
       "type": "string",
       "enum": [
        "methods preview",
        "info hooks"
       ]
      }
     },
     "required": [
      "command"
     ],
     "additionalProperties": false
    },
    "annotations": {
     "readOnlyHint": true
    }
   },
   {
    "name": "setup_methods",
    "description": "Change the stored methods choice of this account; call it only with the user's answer. \"methods suggest\" (the default) adds the agent-services methods once per thread as suggestions; \"methods on\" records that the user takes them as their own working methods (same delivery); \"methods off\" stops adding them; \"methods accept\" records the current methods text as the approved one; \"methods keep\" keeps the approved one. Returns the choice now stored.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "command": {
       "type": "string",
       "enum": [
        "methods on",
        "methods off",
        "methods suggest",
        "methods accept",
        "methods keep"
       ]
      }
     },
     "required": [
      "command"
     ],
     "additionalProperties": false
    }
   },
   {
    "name": "setup_sharing",
    "description": "Turn Codex usage sharing off, or read what it sends; call it only with the user's answer. Sharing (the token counts per model per day of the PostModelRequest hook) turns on only with the unchecked box on the Codex sign-in page. \"sharing off\" withdraws it (the counts are then dropped unread); \"sharing not_now\" leaves it as it is; \"sharing preview\" returns what the hook sends, what the server keeps and today's stored counts. Returns whether sharing is on.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "command": {
       "type": "string",
       "enum": [
        "sharing off",
        "sharing not_now",
        "sharing preview"
       ]
      }
     },
     "required": [
      "command"
     ],
     "additionalProperties": false
    }
   }
  ],
  "hook_tools": [
   {
    "name": "hook_session",
    "description": "Codex SessionStart and UserPromptSubmit mcp_tool hook, not listed in tools/list: adds the methods core (at most 8,000 characters) once per thread (_meta.threadId) on whichever event comes first; later calls in the thread and a methods choice of off add nothing. Input is a literal event name, never a prompt field.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "event": {
       "type": "string",
       "enum": [
        "SessionStart",
        "UserPromptSubmit"
       ]
      }
     },
     "additionalProperties": false
    }
   },
   {
    "name": "hook_spawn",
    "description": "Codex PreToolUse mcp_tool hook on spawn_agent, not listed in tools/list. v2 (matcher collaborationspawn_agent) sends {\"v\": \"v2\", \"task\": \"${tool_input.task_name}\"}: the first spawn per (thread, task name) with a known task word is denied with the advised model and effort, the repeat passes. v1 (matcher spawn_agent) sends {\"v\": \"v1\", \"turn\": \"${turn_id}\"}: the first spawn per (thread, turn) is denied with the whole tier table, the rest of that turn passes. Never the brief (tool_input.message) or the whole tool_input.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "v": {
       "type": "string",
       "enum": [
        "v1",
        "v2"
       ]
      },
      "task": {
       "type": "string",
       "pattern": "^[a-z0-9_]{1,64}$",
       "maxLength": 64
      },
      "turn": {
       "type": "string",
       "pattern": "^[0-9A-Za-z._:-]{1,128}$",
       "maxLength": 128
      }
     },
     "required": [
      "v"
     ],
     "additionalProperties": false
    }
   },
   {
    "name": "hook_usage",
    "description": "Codex PostModelRequest mcp_tool hook (Codex 0.167 and later), not listed in tools/list: called after each model request with {\"model\": \"${model}\", \"status\": \"${status}\", \"usage\": \"${token_usage}\"} (usage: input_tokens, cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens, total_tokens; null counts as a request with no tokens). Always answers {} at once, before any store write. With Codex usage sharing on (consent codex_usage_upload, the company's savings record not off, not paused) the server adds input, cached input, output and reasoning tokens and one request to the account's daily sums per model (flushed every 60 s, kept 13 months); with it off the call is dropped unread and unlogged. Extra keys are allowed and ignored; no thread id is needed.",
    "inputSchema": {
     "type": "object",
     "properties": {
      "model": {
       "type": "string",
       "maxLength": 200
      },
      "status": {
       "type": "string",
       "maxLength": 64
      },
      "usage": {
       "anyOf": [
        {
         "type": "object"
        },
        {
         "type": "string",
         "maxLength": 4000
        },
        {
         "type": "null"
        }
       ]
      }
     },
     "additionalProperties": true
    }
   }
  ],
  "hook_answer": "A hook tool's result is one text content holding Codex hook JSON: {\"hookSpecificOutput\": {\"hookEventName\", \"additionalContext\"}} for hook_session, {\"hookSpecificOutput\": {\"hookEventName\": \"PreToolUse\", \"permissionDecision\": \"deny\", \"permissionDecisionReason\"}} for a routed spawn, and {} (no decision, Codex goes on as without the hook) otherwise, always for hook_usage, also for bad input, a paused company, an inactive license or any server-side failure (the hooks fail open). Per-thread state (methods sent, spawns denied) is kept in process memory for 2 hours; nothing from a hook input is stored or logged, except hook_usage's token counts, which with Codex usage sharing on become daily sums per account and model.",
  "gate": "Tools other than status, setup, setup_methods and setup_sharing, and the hook tools hook_session and hook_spawn, follow the same rules as the svc/1 routes they stand for (router_advice and hook_spawn: POST /router/decide; checkpoint_advice: POST /checkpoint/timing; lesson_lookup and hook_session: POST /served/fetch): a paused company, an inactive or missing license, or a plan without the route gives a tool error (isError true, the error code as text), and an empty hook answer. hook_usage follows the Codex usage-sharing rules instead (see its description); setup_sharing works also while the company is paused."
 },
 "x-oauth": {
  "description": "OAuth 2.1 authorization server for the Codex MCP path (plaintext, unsigned; through the Cloudflare Tunnel). Issuer = limits unsubscribe_base_url; protected resource = <issuer>/mcp. One static public client, no dynamic registration.",
  "client_id": "agent-services-codex",
  "token_endpoint_auth_method": "none",
  "scopes": [
   "mcp"
  ],
  "pkce": [
   "S256"
  ],
  "redirect_uris": "http:// on the standard IPv4 loopback host address or on [::1]; any port and path (RFC 8252 loopback redirects); not the name localhost, no other address",
  "resource": "<issuer>/mcp (RFC 8707), required at authorize and token",
  "code_seconds": 60,
  "access_token_seconds": 3600,
  "refresh": "rotates on each use; lives as long as the grant (device-session idle 30 d / total 90 d); a token first used at most 30 s ago is accepted again unless a successor is in use; using a successor revokes its siblings; reuse after 30 s revokes the grant",
  "endpoints": {
   "GET /.well-known/oauth-protected-resource": "RFC 9728 (also at /.well-known/oauth-protected-resource/mcp)",
   "GET /.well-known/oauth-authorization-server": "RFC 8414",
   "GET|POST /oauth/authorize": "HTML page: email, then code with the consent line; 303 to redirect_uri with code, state, iss",
   "POST /oauth/token": "application/x-www-form-urlencoded: client_id, grant_type (authorization_code | refresh_token), code, code_verifier, redirect_uri, resource, refresh_token; JSON answer access_token, token_type Bearer, expires_in, refresh_token, scope; errors RFC 6749 (invalid_request, invalid_client 401, invalid_grant, invalid_target, unsupported_grant_type); 503 not_configured without a public base",
   "POST /oauth/revoke": "RFC 7009, form client_id, token (refresh or access), optional token_type_hint; ends the whole grant; 200 always for a valid request"
  },
  "grant": "a sessions row with kind 'oauth', harness 'codex', device_id 'codex_<16 hex>', empty device_pubkey; pending until the code is exchanged; not in device lists and no device switch; an active grant shares max_devices (default 1) with the account's Claude device sessions, newest wins (a Codex sign-in ends the Claude session, a Claude sign-in ends the grant and revokes its tokens); a pending grant counts for nothing; logout, admin revoke and licenses apply; the device-signed path refuses it (auth checks kind 'device'); the privacy export includes grants of every status",
  "rate_limits": "every OAuth path takes the per-IP login bucket before the body is read; POST /oauth/authorize also the per-email and IP bucket and the sign-in guess lock; the request log keeps the path only, never the query or the body"
 },
 "definitions": {
  "Error": {
   "type": "object",
   "properties": {
    "error": {
     "type": "object",
     "properties": {
      "code": {
       "type": "string",
       "pattern": "^[a-z][a-z0-9_]*$"
      },
      "message": {
       "type": "string",
       "minLength": 1
      },
      "next": {
       "type": "string"
      }
     },
     "required": [
      "code",
      "message",
      "next"
     ]
    }
   },
   "required": [
    "error"
   ]
  },
  "SessionRef": {
   "type": "string",
   "pattern": "^[0-9a-f]{32}$",
   "maxLength": 32,
   "description": "random id generated for each session on this machine; not a session name, project name or path"
  },
  "SessionKind": {
   "enum": [
    "auto",
    "direct"
   ],
   "description": "auto = a session that advances on its own; direct = a session the user works in directly"
  },
  "Sha256": {
   "type": "string",
   "pattern": "^[0-9a-f]{64}$",
   "maxLength": 64
  },
  "SessionMark": {
   "type": "string",
   "pattern": "^[a-z]{2,8}-[0-9a-f]{16,32}$",
   "maxLength": 41,
   "description": "legacy placeholder"
  },
  "SessionTag": {
   "type": "string",
   "pattern": "^[a-z]{2,8}-[0-9a-f]{16,32}$",
   "maxLength": 41,
   "description": "legacy placeholder"
  },
  "Version": {
   "type": "string",
   "pattern": "^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$",
   "maxLength": 40
  },
  "ServedRole": {
   "enum": [
    "control",
    "auto",
    "plugin"
   ],
   "description": "control = scheduling session; auto = a session that advances on its own; plugin = plugin"
  },
  "McpServedRole": {
   "enum": [
    "codex"
   ],
   "description": "served roles published like a ServedRole but served only on the Codex MCP endpoint (x-mcp: hook_session and lesson_lookup), never through POST /served/fetch or /served/session; codex = the Codex methods variant"
  },
  "ServedPhase": {
   "enum": [
    "plan",
    "implement",
    "test",
    "review",
    "deliver",
    "checkpoint"
   ]
  },
  "OrgSummary": {
   "type": "object",
   "description": "Company board: the org's reported week (the last complete ISO week, UTC, the week the weekly mails report) for an org admin. total_usd = the sum of the people's savings, each rounded to cents; prev_usd = the same people's savings the week before, null with no measured day that week; people = every member, ordered by email only, never by figure (DPIA P7; usd null = no measured day that week, shown as no data yet), and empty in the totals view; devices = distinct devices with an active sign-in; seats_paid null = no seat limit; summary_mail = the weekly org summary mail setting; mail_to = its address, masked, or null when none is set; view = the company's board view: totals (the default for new companies: only the total and with_data, no per-person row) or members; with_data = how many members have a measured day that week",
   "properties": {
    "org": {
     "type": "string",
     "maxLength": 200
    },
    "week": {
     "type": "object",
     "properties": {
      "first_day": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      },
      "last_day": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      }
     },
     "required": [
      "first_day",
      "last_day"
     ],
     "additionalProperties": false
    },
    "total_usd": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1000000000
    },
    "prev_usd": {
     "anyOf": [
      {
       "type": "number",
       "minimum": -1000000000,
       "maximum": 1000000000
      },
      {
       "type": "null"
      }
     ]
    },
    "people": {
     "type": "array",
     "maxItems": 10000,
     "items": {
      "type": "object",
      "properties": {
       "email": {
        "type": "string",
        "maxLength": 254
       },
       "usd": {
        "anyOf": [
         {
          "type": "number",
          "minimum": -1000000000,
          "maximum": 1000000000
         },
         {
          "type": "null"
         }
        ]
       },
       "devices": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       }
      },
      "required": [
       "email",
       "usd",
       "devices"
      ],
      "additionalProperties": false
     }
    },
    "seats_used": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    },
    "seats_paid": {
     "anyOf": [
      {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      {
       "type": "null"
      }
     ]
    },
    "paused": {
     "type": "boolean"
    },
    "savings": {
     "$ref": "#/definitions/OrgSavings"
    },
    "summary_mail": {
     "type": "boolean"
    },
    "mail_to": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 254
      },
      {
       "type": "null"
      }
     ]
    },
    "view": {
     "enum": [
      "totals",
      "members"
     ]
    },
    "with_data": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    },
    "codex": {
     "type": "object",
     "description": "Codex use in the reported week, totals for the company only (never per person), from the members who share their Codex usage: requests and token counts per model, usd = an estimated cost at OpenAI's public list prices (null for a model without a public price: tokens only), prices_checked = the date the price table was read; spawn = the Codex subagent advice counts (advised = spawns refused with the advised model, followed = repeat spawns that went through). No saving is claimed for Codex. Sent only to a shell release 0.9.3 or later",
     "properties": {
      "requests": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000000000000
      },
      "people": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      "usd": {
       "anyOf": [
        {
         "type": "number",
         "minimum": 0,
         "maximum": 1000000000
        },
        {
         "type": "null"
        }
       ]
      },
      "prices_checked": {
       "anyOf": [
        {
         "type": "string",
         "maxLength": 10
        },
        {
         "type": "null"
        }
       ]
      },
      "models": {
       "type": "array",
       "maxItems": 10000,
       "items": {
        "type": "object",
        "properties": {
         "model": {
          "type": "string",
          "maxLength": 64
         },
         "requests": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000000000000
         },
         "input_tokens": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000000000000
         },
         "cached_input_tokens": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000000000000
         },
         "output_tokens": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000000000000
         },
         "reasoning_output_tokens": {
          "type": "integer",
          "minimum": 0,
          "maximum": 1000000000000000
         },
         "usd": {
          "anyOf": [
           {
            "type": "number",
            "minimum": 0,
            "maximum": 1000000000
           },
           {
            "type": "null"
           }
          ]
         }
        },
        "required": [
         "model",
         "requests",
         "input_tokens",
         "cached_input_tokens",
         "output_tokens",
         "reasoning_output_tokens",
         "usd"
        ],
        "additionalProperties": false
       }
      },
      "spawn": {
       "type": "object",
       "properties": {
        "advised": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000000000000
        },
        "followed": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000000000000
        }
       },
       "required": [
        "advised",
        "followed"
       ],
       "additionalProperties": false
      }
     },
     "required": [
      "requests",
      "people",
      "usd",
      "prices_checked",
      "models",
      "spawn"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "org",
    "week",
    "total_usd",
    "prev_usd",
    "people",
    "seats_used",
    "seats_paid",
    "paused",
    "savings",
    "summary_mail",
    "mail_to",
    "view",
    "with_data"
   ],
   "additionalProperties": false
  },
  "OrgMe": {
   "type": "object",
   "description": "A member's own view (R064): what the company admin's board (OrgSummary) shows about the caller, taken from that same answer, and the company settings that apply to them; never another member's row. in_org false (and every other field null, admin false) = the account is in no company account. you = the caller's row of OrgSummary.people (usd null = no data yet), null only if the board has no row for the caller; week = OrgSummary.week; admin = the caller is an active admin of the company; view = the company's board view (OrgSummary.view; in totals the board has no row for anyone, so you is null), null outside a company",
   "properties": {
    "in_org": {
     "type": "boolean"
    },
    "org": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 200
      },
      {
       "type": "null"
      }
     ]
    },
    "admin": {
     "type": "boolean"
    },
    "week": {
     "anyOf": [
      {
       "type": "object",
       "properties": {
        "first_day": {
         "type": "string",
         "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
         "maxLength": 10
        },
        "last_day": {
         "type": "string",
         "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
         "maxLength": 10
        }
       },
       "required": [
        "first_day",
        "last_day"
       ],
       "additionalProperties": false
      },
      {
       "type": "null"
      }
     ]
    },
    "you": {
     "anyOf": [
      {
       "type": "object",
       "properties": {
        "email": {
         "type": "string",
         "maxLength": 254
        },
        "usd": {
         "anyOf": [
          {
           "type": "number",
           "minimum": -1000000000,
           "maximum": 1000000000
          },
          {
           "type": "null"
          }
         ]
        },
        "devices": {
         "type": "integer",
         "minimum": 0,
         "maximum": 100000
        }
       },
       "required": [
        "email",
        "usd",
        "devices"
       ],
       "additionalProperties": false
      },
      {
       "type": "null"
      }
     ]
    },
    "paused": {
     "anyOf": [
      {
       "type": "boolean"
      },
      {
       "type": "null"
      }
     ]
    },
    "savings": {
     "anyOf": [
      {
       "$ref": "#/definitions/OrgSavings"
      },
      {
       "type": "null"
      }
     ]
    },
    "view": {
     "anyOf": [
      {
       "enum": [
        "totals",
        "members"
       ]
      },
      {
       "type": "null"
      }
     ]
    }
   },
   "required": [
    "in_org",
    "org",
    "admin",
    "week",
    "you",
    "paused",
    "savings",
    "view"
   ],
   "additionalProperties": false
  },
  "OrgSavings": {
   "enum": [
    "each",
    "on",
    "off"
   ],
   "description": "The org admin's savings-record choice (each = each person decides; on or off = for everyone). The POST /auth/hello answer carries it as {\"org\": {\"savings\": <this>}} for an account in an org, only to a shell release 0.3.0 or later (an older shell, and a dev shell, may refuse an unknown key). For an active org admin (account role admin) the field is {\"savings\": <this>, \"admin\": true}, only to a shell release 0.4.0 or later. A shell release 0.8.0 or later also gets \"view\" (totals | members, OrgSummary.view) and \"has_admin\" (true when someone sees the company board or mail: an admin account or a summary address), so the member's plugin can say once what the admin sees. 423 org_paused answers every signed request and the sign-in while the org's admin has paused the org; sign-out still works"
  },
  "PackTarget": {
   "enum": [
    "pack-a",
    "pack-b",
    "skills",
    "plugin"
   ]
  },
  "PackRef": {
   "type": "object",
   "properties": {
    "name": {
     "type": "string",
     "pattern": "^[a-z0-9][a-z0-9-]{0,39}$",
     "maxLength": 40
    },
    "target": {
     "$ref": "#/definitions/PackTarget"
    },
    "version": {
     "$ref": "#/definitions/Version"
    },
    "min_client": {
     "$ref": "#/definitions/Version"
    },
    "sha256": {
     "$ref": "#/definitions/Sha256"
    },
    "size_bytes": {
     "type": "integer",
     "minimum": 1,
     "maximum": 52428800
    },
    "download": {
     "type": "string",
     "pattern": "^/svc/v1/packs/[a-z-]+/[0-9A-Za-z.+-]+$",
     "maxLength": 120
    }
   },
   "required": [
    "name",
    "target",
    "version",
    "min_client",
    "sha256",
    "size_bytes",
    "download"
   ],
   "additionalProperties": false
  },
  "Savings": {
   "type": "object",
   "description": "savings computed by the server from the uploaded counts; amounts to 6 decimal places, pct to 4; usd and tokens may be negative (compaction can cost more than it saves)",
   "properties": {
    "first_day": {
     "anyOf": [
      {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      },
      {
       "type": "null"
      }
     ]
    },
    "last_day": {
     "anyOf": [
      {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      },
      {
       "type": "null"
      }
     ]
    },
    "days": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    },
    "api_usd": {
     "type": "number",
     "minimum": 0,
     "maximum": 1000000000
    },
    "usd": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1000000000
    },
    "pct": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1
    },
    "route": {
     "$ref": "#/definitions/Lever"
    },
    "compact": {
     "$ref": "#/definitions/Lever"
    },
    "index": {
     "$ref": "#/definitions/Lever"
    },
    "trim": {
     "$ref": "#/definitions/Lever",
     "description": "optional (server 0.7.0): only when a day carries trim rows"
    },
    "by_day": {
     "type": "array",
     "maxItems": 400,
     "items": {
      "type": "object",
      "properties": {
       "day": {
        "type": "string",
        "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
        "maxLength": 10
       },
       "api_usd": {
        "type": "number",
        "minimum": 0,
        "maximum": 1000000000
       },
       "usd": {
        "type": "number",
        "minimum": -1000000000,
        "maximum": 1000000000
       },
       "route_usd": {
        "type": "number",
        "minimum": -1000000000,
        "maximum": 1000000000
       },
       "compact_usd": {
        "type": "number",
        "minimum": -1000000000,
        "maximum": 1000000000
       },
       "index_usd": {
        "type": "number",
        "minimum": -1000000000,
        "maximum": 1000000000
       },
       "trim_usd": {
        "type": "number",
        "minimum": -1000000000,
        "maximum": 1000000000
       },
       "agent_seconds": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000000
       },
       "concurrent_seconds": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000000
       },
       "typed_bytes": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000000000
       }
      },
      "required": [
       "day",
       "api_usd",
       "usd",
       "route_usd",
       "compact_usd",
       "index_usd"
      ],
      "additionalProperties": false
     }
    },
    "time": {
     "type": "object",
     "description": "optional (server 0.7.0): time saved over the same days; agent_seconds = time saved for the person (clock time with at least one agent active), concurrent_seconds = concurrent saving (the agents' summed run time less that clock time), typing_seconds = the person's own time estimated from typed_bytes at typing_bytes_per_minute; method = the disclosure shown wherever the figures appear",
     "properties": {
      "agent_seconds": {
       "type": "integer",
       "minimum": 0,
       "maximum": 100000000000
      },
      "concurrent_seconds": {
       "type": "integer",
       "minimum": 0,
       "maximum": 100000000000
      },
      "typed_bytes": {
       "type": "integer",
       "minimum": 0,
       "maximum": 10000000000000
      },
      "turns": {
       "type": "integer",
       "minimum": 0,
       "maximum": 10000000000
      },
      "typing_seconds": {
       "type": "integer",
       "minimum": 0,
       "maximum": 100000000000
      },
      "typing_bytes_per_minute": {
       "type": "integer",
       "minimum": 1,
       "maximum": 100000
      },
      "days": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000
      },
      "method": {
       "type": "string",
       "maxLength": 1000
      }
     },
     "required": [
      "agent_seconds",
      "concurrent_seconds",
      "typed_bytes",
      "turns",
      "typing_seconds",
      "typing_bytes_per_minute",
      "days",
      "method"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "first_day",
    "last_day",
    "days",
    "api_usd",
    "usd",
    "pct",
    "route",
    "compact",
    "index",
    "by_day"
   ],
   "additionalProperties": false
  },
  "Lever": {
   "type": "object",
   "properties": {
    "usd": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1000000000
    },
    "tokens": {
     "type": "integer",
     "minimum": -1000000000000000,
     "maximum": 1000000000000000
    },
    "runs": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000000
    }
   },
   "required": [
    "usd",
    "tokens",
    "runs"
   ],
   "additionalProperties": false
  },
  "DiagSide": {
   "type": "object",
   "properties": {
    "input_tokens": {
     "type": "integer",
     "minimum": 0,
     "maximum": 10000000000000
    },
    "output_tokens": {
     "type": "integer",
     "minimum": 0,
     "maximum": 10000000000000
    },
    "cache_read_tokens": {
     "type": "integer",
     "minimum": 0,
     "maximum": 10000000000000
    },
    "cache_write_tokens": {
     "type": "integer",
     "minimum": 0,
     "maximum": 10000000000000
    },
    "api_usd": {
     "type": "number",
     "minimum": 0,
     "maximum": 100000000
    },
    "responses": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000000
    }
   },
   "required": [
    "input_tokens",
    "output_tokens",
    "cache_read_tokens",
    "cache_write_tokens",
    "api_usd",
    "responses"
   ],
   "additionalProperties": false
  },
  "DiagEstimateRequest": {
   "type": "object",
   "description": "One-time summary for the free usage diagnostic: counts and amounts only, with no session or project hashes, per-day rows, paths, names or text. The server also checks that fields agree with each other, outside the schema; if they do not, it answers 422 bad_request. When there is too little data to estimate, it answers 422 too_little_data",
   "properties": {
    "schema": {
     "type": "string",
     "const": "diag-est-1",
     "maxLength": 10
    },
    "client_version": {
     "$ref": "#/definitions/Version"
    },
    "harness": {
     "type": "string",
     "const": "claude-code",
     "maxLength": 11
    },
    "window": {
     "type": "object",
     "properties": {
      "first_day": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      },
      "last_day": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      }
     },
     "required": [
      "first_day",
      "last_day"
     ],
     "additionalProperties": false
    },
    "by_model": {
     "type": "array",
     "maxItems": 40,
     "description": "one row per model (past 40 models, the rest are merged into other); main conversation and subagents kept separate",
     "items": {
      "type": "object",
      "properties": {
       "model": {
        "type": "string",
        "pattern": "^(claude-[a-z0-9.-]{1,60}|other)$",
        "maxLength": 67
       },
       "main": {
        "$ref": "#/definitions/DiagSide"
       },
       "subagents": {
        "$ref": "#/definitions/DiagSide"
       }
      },
      "required": [
       "model",
       "main",
       "subagents"
      ],
      "additionalProperties": false
     }
    },
    "dispatches": {
     "type": "array",
     "maxItems": 60,
     "description": "counted by the first word of the subagent description (a word from the public tools.diagnostic.TYPE_WORDS, or other); no other text is sent",
     "items": {
      "type": "object",
      "properties": {
       "type_word": {
        "type": "string",
        "pattern": "^\\S{1,20}$",
        "maxLength": 20
       },
       "count": {
        "type": "integer",
        "minimum": 1,
        "maximum": 10000000
       }
      },
      "required": [
       "type_word",
       "count"
      ],
      "additionalProperties": false
     }
    },
    "compactions": {
     "type": "object",
     "properties": {
      "total": {
       "type": "integer",
       "minimum": 0,
       "maximum": 10000000
      },
      "manual": {
       "type": "integer",
       "minimum": 0,
       "maximum": 10000000
      },
      "auto": {
       "type": "integer",
       "minimum": 0,
       "maximum": 10000000
      }
     },
     "required": [
      "total",
      "manual",
      "auto"
     ],
     "additionalProperties": false
    },
    "sessions": {
     "type": "object",
     "properties": {
      "count": {
       "type": "integer",
       "minimum": 0,
       "maximum": 10000000
      },
      "minutes_total": {
       "type": "number",
       "minimum": 0,
       "maximum": 1000000000
      },
      "by_responses": {
       "type": "array",
       "minItems": 14,
       "maxItems": 14,
       "description": "sessions bucketed by reply count (item k = number of sessions with [2^k, 2^(k+1)) replies; the last item includes everything above)",
       "items": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000000
       }
      }
     },
     "required": [
      "count",
      "minutes_total",
      "by_responses"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "schema",
    "client_version",
    "harness",
    "window",
    "by_model",
    "dispatches",
    "compactions",
    "sessions"
   ],
   "additionalProperties": false
  },
  "DiagRange": {
   "type": "object",
   "properties": {
    "value": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1000000000
    },
    "low": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1000000000
    },
    "high": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1000000000
    }
   },
   "required": [
    "value",
    "low",
    "high"
   ],
   "additionalProperties": false
  },
  "DiagLever": {
   "type": "object",
   "properties": {
    "usd": {
     "$ref": "#/definitions/DiagRange"
    },
    "hours": {
     "$ref": "#/definitions/DiagRange"
    }
   },
   "required": [
    "usd",
    "hours"
   ],
   "additionalProperties": false
  },
  "DiagEstimate": {
   "type": "object",
   "description": "Estimated monthly savings (numbers and dates only): dollars and hours for each item, with lower and upper bounds; pct = total as a share of spending; reference = the savings rate we measured ourselves",
   "properties": {
    "schema": {
     "type": "string",
     "const": "diag-est-1",
     "maxLength": 10
    },
    "window": {
     "type": "object",
     "properties": {
      "first_day": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      },
      "last_day": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      },
      "days": {
       "type": "integer",
       "minimum": 1,
       "maximum": 400
      }
     },
     "required": [
      "first_day",
      "last_day",
      "days"
     ],
     "additionalProperties": false
    },
    "api_usd_month": {
     "type": "number",
     "minimum": -1000000000,
     "maximum": 1000000000
    },
    "routing": {
     "$ref": "#/definitions/DiagLever"
    },
    "compaction": {
     "$ref": "#/definitions/DiagLever"
    },
    "index": {
     "$ref": "#/definitions/DiagLever"
    },
    "scripts": {
     "$ref": "#/definitions/DiagLever"
    },
    "total": {
     "$ref": "#/definitions/DiagLever"
    },
    "pct": {
     "$ref": "#/definitions/DiagRange"
    },
    "reference": {
     "type": "object",
     "properties": {
      "pct": {
       "type": "number",
       "minimum": 0,
       "maximum": 1
      },
      "since": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
       "maxLength": 10
      }
     },
     "required": [
      "pct",
      "since"
     ],
     "additionalProperties": false
    }
   },
   "required": [
    "schema",
    "window",
    "api_usd_month",
    "routing",
    "compaction",
    "index",
    "scripts",
    "total",
    "pct",
    "reference"
   ],
   "additionalProperties": false
  },
  "OutboxLine": {
   "type": "object",
   "properties": {
    "ts": {
     "type": "string",
     "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
     "maxLength": 32
    },
    "service": {
     "enum": [
      "health",
      "updates",
      "incidents",
      "metrics",
      "auth",
      "router",
      "checkpoint",
      "limits"
     ],
     "description": "auth = /svc/v1/auth/* (login, rotation, logout)"
    },
    "method": {
     "enum": [
      "GET",
      "POST",
      "DELETE"
     ]
    },
    "route": {
     "type": "string",
     "pattern": "^(/svc/v1/|/health$)",
     "maxLength": 120
    },
    "preview": {
     "type": "boolean",
     "description": "true = only builds the request body so the customer can see it; nothing is sent"
    },
    "body_text": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 65536
      },
      {
       "type": "null"
      }
     ],
     "description": "the exact request body that was sent; null for GET/DELETE"
    },
    "status": {
     "anyOf": [
      {
       "type": "integer",
       "minimum": 100,
       "maximum": 599
      },
      {
       "type": "null"
      }
     ],
     "description": "null when previewing or when the connection fails"
    },
    "response_text": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 65536
      },
      {
       "type": "null"
      }
     ]
    },
    "error": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 300
      },
      {
       "type": "null"
      }
     ],
     "description": "local errors such as a failed connection or a timeout; never contains the key"
    },
    "outer_path": {
     "enum": [
      "/svc/v1/x",
      "/svc/v1/auth/login/x"
     ],
     "description": "the outer path the sealed request was posted to; absent for GET /health (sent plain) and for previews"
    },
    "outer_bytes": {
     "type": "integer",
     "minimum": 0,
     "maximum": 16777216,
     "description": "length of the outer (base64) body as sent; absent when outer_path is"
    }
   },
   "required": [
    "ts",
    "service",
    "method",
    "route",
    "preview",
    "body_text",
    "status",
    "response_text",
    "error"
   ],
   "additionalProperties": false
  },
  "OutboxToolLine": {
   "type": "object",
   "description": "a call the model made to one of our tools: the tool name and its arguments as JSON text",
   "properties": {
    "ts": {
     "type": "string",
     "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
     "maxLength": 32
    },
    "kind": {
     "const": "tool"
    },
    "name": {
     "type": "string",
     "maxLength": 120
    },
    "arguments_text": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 65536
      },
      {
       "type": "null"
      }
     ]
    }
   },
   "required": [
    "ts",
    "kind",
    "name",
    "arguments_text"
   ],
   "additionalProperties": false
  },
  "OutboxPublishLine": {
   "type": "object",
   "description": "a dashboard publish attempt through the Artifact tool (the one egress that is not our service): the Artifact input fields, the page's sha256 and size, and the outcome",
   "properties": {
    "ts": {
     "type": "string",
     "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
     "maxLength": 32
    },
    "kind": {
     "const": "artifact_publish"
    },
    "input": {
     "type": "object",
     "properties": {
      "file_path": {
       "type": "string",
       "maxLength": 1000
      },
      "url": {
       "type": "string",
       "maxLength": 1000
      },
      "icon": {
       "type": "string",
       "maxLength": 1000
      }
     },
     "required": [
      "file_path"
     ],
     "additionalProperties": false
    },
    "sha256": {
     "type": "string",
     "pattern": "^[0-9a-f]{64}$",
     "maxLength": 64
    },
    "size": {
     "type": "integer",
     "minimum": 0,
     "maximum": 16777216
    },
    "outcome": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 300
      },
      {
       "type": "null"
      }
     ],
     "description": "published, denied or failed"
    },
    "reason": {
     "anyOf": [
      {
       "type": "string",
       "maxLength": 200
      },
      {
       "type": "null"
      }
     ],
     "description": "on a denied call only, when the tool gave one: why it was denied"
    }
   },
   "required": [
    "ts",
    "kind",
    "input",
    "sha256",
    "size",
    "outcome"
   ],
   "additionalProperties": false
  },
  "OutboxCapLine": {
   "type": "object",
   "description": "written last in a file that reached its size cap: how many lines were left out",
   "properties": {
    "ts": {
     "type": "string",
     "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?Z$",
     "maxLength": 32
    },
    "kind": {
     "const": "cap"
    },
    "dropped": {
     "type": "integer",
     "minimum": 1,
     "maximum": 1000000000
    }
   },
   "required": [
    "ts",
    "kind",
    "dropped"
   ],
   "additionalProperties": false
  }
 },
 "routes": [
  {
   "method": "GET",
   "path": "/health",
   "request": null,
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "api": {
       "const": "svc/1"
      },
      "ok": {
       "type": "boolean"
      }
     },
     "required": [
      "api",
      "ok"
     ],
     "additionalProperties": false
    }
   },
   "errors": {},
   "x-inventory": {
    "service": "health",
    "purpose": "connectivity and key check ('Test connection' on the settings page)",
    "default": "on",
    "retention": "no content stored; access log (client_id, time, status code) kept 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/updates/check",
   "request": {
    "type": "object",
    "properties": {
     "client_version": {
      "$ref": "#/definitions/Version"
     },
     "os": {
      "enum": [
       "windows",
       "macos",
       "linux"
      ]
     },
     "channel": {
      "enum": [
       "stable",
       "beta"
      ]
     },
     "pinned_version": {
      "anyOf": [
       {
        "$ref": "#/definitions/Version"
       },
       {
        "type": "null"
       }
      ]
     },
     "installed_pack_versions": {
      "type": "array",
      "maxItems": 20,
      "items": {
       "type": "object",
       "properties": {
        "target": {
         "$ref": "#/definitions/PackTarget"
        },
        "version": {
         "$ref": "#/definitions/Version"
        }
       },
       "required": [
        "target",
        "version"
       ],
       "additionalProperties": false
      }
     }
    },
    "required": [
     "client_version",
     "os",
     "channel",
     "pinned_version",
     "installed_pack_versions"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "packs": {
       "type": "array",
       "maxItems": 20,
       "items": {
        "$ref": "#/definitions/PackRef"
       }
      }
     },
     "required": [
      "packs"
     ],
     "additionalProperties": false
    }
   },
   "errors": {},
   "x-inventory": {
    "service": "updates",
    "purpose": "check whether a new update package exists; sends no project, session or content",
    "default": "on (only shows a notice when a new version exists)",
    "retention": "download record (client_id, version, time) kept 90 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "GET",
   "path": "/packs/{target}/{version}",
   "x-params": {
    "target": "^(pack-a|pack-b|skills|plugin)$",
    "version": "^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$"
   },
   "request": null,
   "x-response-body": "raw: tar package containing manifest.json and manifest.sig (Ed25519); the client verifies the signature with the pinned public key",
   "responses": {
    "200": null
   },
   "errors": {},
   "x-inventory": {
    "service": "updates",
    "purpose": "download the update package; sends only the target and version in the path",
    "default": "on",
    "retention": "download record (client_id, version, time) kept 90 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/served/fetch",
   "request": {
    "type": "object",
    "properties": {
     "session_ref": {
      "$ref": "#/definitions/SessionRef"
     },
     "role": {
      "$ref": "#/definitions/ServedRole"
     },
     "phase": {
      "$ref": "#/definitions/ServedPhase"
     },
     "pinned_version": {
      "anyOf": [
       {
        "$ref": "#/definitions/Version"
       },
       {
        "type": "null"
       }
      ],
      "description": "the version this session is bound to; otherwise the version the client pinned for this role; otherwise null (= the current version on the channel)"
     },
     "channel": {
      "enum": [
       "stable",
       "beta"
      ]
     }
    },
    "required": [
     "session_ref",
     "role",
     "phase",
     "pinned_version",
     "channel"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "role": {
       "$ref": "#/definitions/ServedRole"
      },
      "phase": {
       "$ref": "#/definitions/ServedPhase"
      },
      "version": {
       "$ref": "#/definitions/Version"
      },
      "channel": {
       "enum": [
        "stable",
        "beta"
       ],
       "description": "the channel this served version is on now"
      },
      "pinned": {
       "type": "boolean",
       "description": "the request carried a pinned version"
      },
      "catalog": {
       "type": "string",
       "maxLength": 200,
       "description": "the catalog line for this phase; an empty string when there is none"
      },
      "items": {
       "type": "array",
       "maxItems": 1000,
       "description": "every base and granted kit item of the phase; no item-count limit, 1000 only bounds a runaway answer",
       "items": {
        "type": "object",
        "properties": {
         "id": {
          "type": "string",
          "pattern": "^[a-z0-9][a-z0-9-]{0,39}$",
          "maxLength": 40
         },
         "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 20000
         },
         "sha256": {
          "$ref": "#/definitions/Sha256"
         }
        },
        "required": [
         "id",
         "text",
         "sha256"
        ],
        "additionalProperties": false
       }
      }
     },
     "required": [
      "role",
      "phase",
      "version",
      "channel",
      "pinned",
      "catalog",
      "items"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "404": [
     "no_served_version",
     "no_such_version"
    ],
    "403": [
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "updates",
    "purpose": "fetch the content the service serves for each phase; sends only the random session id, role, phase, pinned version and channel",
    "default": "on",
    "retention": "request content not stored; access log kept 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/served/session",
   "request": {
    "type": "object",
    "properties": {
     "session_ref": {
      "$ref": "#/definitions/SessionRef"
     },
     "role": {
      "$ref": "#/definitions/ServedRole"
     }
    },
    "required": [
     "session_ref",
     "role"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "session_ref": {
       "$ref": "#/definitions/SessionRef"
      },
      "watermark": {
       "$ref": "#/definitions/SessionMark",
       "description": "legacy field: the same fixed placeholder for every session; served text carries no marks"
      },
      "canaries": {
       "type": "array",
       "minItems": 1,
       "maxItems": 4,
       "uniqueItems": true,
       "items": {
        "$ref": "#/definitions/SessionTag"
       },
       "description": "legacy field: the same fixed placeholder for every session; served text carries no marks"
      },
      "fp": {
       "type": "object",
       "properties": {
        "key": {
         "$ref": "#/definitions/Sha256",
         "description": "legacy field: the same fixed placeholder for every session; served text carries no marks"
        },
        "shingle": {
         "type": "integer",
         "minimum": 4,
         "maximum": 64
        },
        "window": {
         "type": "integer",
         "minimum": 1,
         "maximum": 32
        }
       },
       "required": [
        "key",
        "shingle",
        "window"
       ],
       "additionalProperties": false
      },
      "thresholds": {
       "type": "object",
       "properties": {
        "run": {
         "type": "integer",
         "minimum": 1,
         "maximum": 1000
        },
        "share": {
         "type": "number",
         "minimum": 0.01,
         "maximum": 1
        }
       },
       "required": [
        "run",
        "share"
       ],
       "additionalProperties": false
      }
     },
     "required": [
      "session_ref",
      "watermark",
      "canaries",
      "fp",
      "thresholds"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ],
    "409": [
     "role_mismatch"
    ]
   },
   "x-response-secret": [
    "watermark",
    "canaries",
    "fp",
    "thresholds"
   ],
   "x-inventory": {
    "service": "updates",
    "purpose": "sends only the random session id and role; receives fixed legacy fields and the thresholds in return",
    "default": "on (once when the session opens; not sent when served content is turned off)",
    "retention": "session record kept 13 months",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/served/rules",
   "request": {
    "type": "object",
    "properties": {
     "channel": {
      "enum": [
       "stable",
       "beta"
      ]
     }
    },
    "required": [
     "channel"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "version": {
       "$ref": "#/definitions/Version"
      },
      "scope": {
       "enum": [
        "product",
        "account"
       ],
       "description": "account = the product tables plus rules kept for this account only"
      },
      "tables": {
       "type": "object",
       "description": "rule tables by name (command guard, secret masking, trim, subagents, watch); the plugin runs them locally and keeps them in memory only"
      }
     },
     "required": [
      "version",
      "scope",
      "tables"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ],
    "404": [
     "no_rules"
    ]
   },
   "x-inventory": {
    "service": "updates",
    "purpose": "fetch the rule tables the plugin runs locally (command guard, secret masking, row trimming, subagent and shell watch); sends only the channel; no command, prompt or tool text is sent",
    "default": "on (once when a signed-in session starts)",
    "retention": "request content not stored; access log kept 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/incidents",
   "request": {
    "type": "object",
    "properties": {
     "session_ref": {
      "$ref": "#/definitions/SessionRef"
     },
     "harness": {
      "enum": [
       "claude-code",
       "opencode",
       "codex",
       "other"
      ]
     },
     "harness_version": {
      "type": "string",
      "pattern": "^[0-9A-Za-z.+-]+$",
      "maxLength": 40
     },
     "model": {
      "type": "string",
      "pattern": "^[0-9A-Za-z.:/_-]+$",
      "maxLength": 80
     },
     "tool": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_.:-]+$",
      "maxLength": 80
     },
     "error_class": {
      "type": "string",
      "pattern": "^[A-Za-z0-9_.:-]+$",
      "maxLength": 80
     },
     "error_template": {
      "type": "string",
      "minLength": 1,
      "maxLength": 300,
      "description": "first line of the error after templating (host/incident.py template: paths, URLs, quoted strings, numbers and identifiers are replaced with placeholders); the raw error line is never sent"
     },
     "error_sha256": {
      "$ref": "#/definitions/Sha256",
      "description": "sha256 of the redacted first line (used only to count how many distinct errors there are)"
     },
     "file_ext": {
      "anyOf": [
       {
        "type": "string",
        "pattern": "^\\.[A-Za-z0-9]{1,10}$",
        "maxLength": 11
       },
       {
        "type": "null"
       }
      ],
      "description": "extension of the file involved; no path or file name"
     },
     "outcome": {
      "enum": [
       "fixed",
       "retried",
       "failed"
      ]
     }
    },
    "required": [
     "session_ref",
     "harness",
     "harness_version",
     "model",
     "tool",
     "error_class",
     "error_template",
     "error_sha256",
     "file_ext",
     "outcome"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "received": {
       "const": true
      }
     },
     "required": [
      "received"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "service_off",
     "not_in_plan"
    ],
    "429": [
     "too_many"
    ]
   },
   "x-inventory": {
    "service": "incidents",
    "purpose": "incident reports, fed to the lesson-curation pipeline (no code, file contents or paths)",
    "default": "off (the customer turns it on)",
    "retention": "kept until a lesson is made or rejected from it, for at most 180 days; session_ref is not stored",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/metrics/daily",
   "request": {
    "type": "object",
    "description": "The server also checks that fields agree with each other, outside the schema; if they do not, it answers 422 bad_request. If day is not a calendar date or is outside the date range the server accepts, it answers 422 bad_day",
    "properties": {
     "day": {
      "type": "string",
      "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
      "maxLength": 10
     },
     "client_version": {
      "$ref": "#/definitions/Version"
     },
     "by_model": {
      "type": "array",
      "maxItems": 50,
      "items": {
       "type": "object",
       "properties": {
        "model": {
         "type": "string",
         "pattern": "^[0-9A-Za-z.:/_-]+$",
         "maxLength": 80
        },
        "input_tokens": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000000000
        },
        "output_tokens": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000000000
        },
        "cache_read_tokens": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000000000
        },
        "cache_write_tokens": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000000000
        },
        "api_usd": {
         "type": "number",
         "minimum": 0,
         "maximum": 1000000
        }
       },
       "required": [
        "model",
        "input_tokens",
        "output_tokens",
        "cache_read_tokens",
        "cache_write_tokens",
        "api_usd"
       ],
       "additionalProperties": false
      }
     },
     "by_task": {
      "type": "array",
      "maxItems": 500,
      "items": {
       "type": "object",
       "properties": {
        "task_type": {
         "type": "string",
         "maxLength": 20,
         "description": "first word of the subagent description (the routing task type)"
        },
        "model": {
         "type": "string",
         "pattern": "^[0-9A-Za-z.:/_-]+$",
         "maxLength": 80
        },
        "project_hash": {
         "type": "string",
         "pattern": "^[0-9a-f]{16}$",
         "maxLength": 16,
         "description": "HMAC(local salt, project); can group but cannot recover the project name"
        },
        "count": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000
        },
        "success": {
         "anyOf": [
          {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000
          },
          {
           "type": "null"
          }
         ],
         "description": "null = not recorded (session records do not keep results)"
        },
        "fail": {
         "anyOf": [
          {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000
          },
          {
           "type": "null"
          }
         ]
        },
        "retry": {
         "anyOf": [
          {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000
          },
          {
           "type": "null"
          }
         ]
        },
        "median_seconds": {
         "anyOf": [
          {
           "type": "number",
           "minimum": 0,
           "maximum": 86400
          },
          {
           "type": "null"
          }
         ]
        }
       },
       "required": [
        "task_type",
        "model",
        "project_hash",
        "count",
        "success",
        "fail",
        "retry",
        "median_seconds"
       ],
       "additionalProperties": false
      }
     },
     "sessions": {
      "type": "array",
      "maxItems": 20,
      "items": {
       "type": "object",
       "properties": {
        "kind": {
         "$ref": "#/definitions/SessionKind"
        },
        "harness": {
         "enum": [
          "claude-code",
          "codex",
          "other"
         ]
        },
        "count": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000
        }
       },
       "required": [
        "kind",
        "harness",
        "count"
       ],
       "additionalProperties": false
      }
     },
     "savings": {
      "type": "object",
      "description": "raw counts the savings formula needs; omit when absent. The server computes amounts; the client does not",
      "properties": {
       "route": {
        "type": "array",
        "maxItems": 100,
        "description": "routed subagent turns, one row per (model, long) per day",
        "items": {
         "type": "object",
         "properties": {
          "model": {
           "type": "string",
           "pattern": "^[0-9A-Za-z.:/_-]+$",
           "maxLength": 80
          },
          "long": {
           "type": "boolean",
           "description": "this turn's prompt is over long_prompt.over in the public price list for this model"
          },
          "turns": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000
          },
          "input_tokens": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000000000
          },
          "output_tokens": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000000000
          },
          "cache_read_tokens": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000000000
          },
          "cache_write_tokens": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000000000
          }
         },
         "required": [
          "model",
          "long",
          "turns",
          "input_tokens",
          "output_tokens",
          "cache_read_tokens",
          "cache_write_tokens"
         ],
         "additionalProperties": false
        }
       },
       "index": {
        "type": "array",
        "maxItems": 500,
        "description": "segmented reads of index files, one row per (model, file_tokens) per day",
        "items": {
         "type": "object",
         "properties": {
          "model": {
           "type": "string",
           "pattern": "^[0-9A-Za-z.:/_-]+$",
           "maxLength": 80
          },
          "file_tokens": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000000,
           "description": "token estimate for the whole file that was read"
          },
          "reads": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000
          }
         },
         "required": [
          "model",
          "file_tokens",
          "reads"
         ],
         "additionalProperties": false
        }
       },
       "compact": {
        "type": "array",
        "maxItems": 50,
        "description": "checkpoint compactions, one row per ref per day; steps that cross a day boundary are joined on the server by ref",
        "items": {
         "type": "object",
         "properties": {
          "ref": {
           "type": "string",
           "pattern": "^[0-9a-f]{16}$",
           "maxLength": 16,
           "description": "random id generated for each compaction, not the session id"
          },
          "start": {
           "anyOf": [
            {
             "type": "object",
             "properties": {
              "model": {
               "type": "string",
               "pattern": "^[0-9A-Za-z.:/_-]+$",
               "maxLength": 80
              },
              "before_tokens": {
               "type": "integer",
               "minimum": 0,
               "maximum": 1000000000000
              },
              "after_tokens": {
               "anyOf": [
                {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 1000000000000
                },
                {
                 "type": "null"
                }
               ]
              },
              "window_tokens": {
               "type": "integer",
               "minimum": 0,
               "maximum": 1000000000000
              },
              "threshold_tokens": {
               "anyOf": [
                {
                 "type": "integer",
                 "minimum": 0,
                 "maximum": 1000000000000
                },
                {
                 "type": "null"
                }
               ]
              },
              "compact_usd": {
               "anyOf": [
                {
                 "type": "number",
                 "minimum": 0,
                 "maximum": 1000000
                },
                {
                 "type": "null"
                }
               ]
              }
             },
             "required": [
              "model",
              "before_tokens",
              "after_tokens",
              "window_tokens",
              "threshold_tokens",
              "compact_usd"
             ],
             "additionalProperties": false
            },
            {
             "type": "null"
            }
           ],
           "description": "the compaction day's starting point; null when the starting point is not on this day"
          },
          "models": {
           "type": "array",
           "maxItems": 10,
           "items": {
            "type": "string",
            "pattern": "^[0-9A-Za-z.:/_-]+$",
            "maxLength": 80
           }
          },
          "steps": {
           "type": "array",
           "maxItems": 4000,
           "description": "each later main-conversation request as [context, index into models]",
           "items": {
            "type": "array",
            "minItems": 2,
            "maxItems": 2,
            "items": {
             "type": "integer",
             "minimum": 0,
             "maximum": 1000000000000
            }
           }
          }
         },
         "required": [
          "ref",
          "start",
          "models",
          "steps"
         ],
         "additionalProperties": false
        }
       },
       "trim": {
        "type": "array",
        "maxItems": 20,
        "description": "optional (plugin 0.7.0): attachment rows rewritten to one line after a compaction, one row per model per day; numbers only",
        "items": {
         "type": "object",
         "properties": {
          "model": {
           "type": "string",
           "pattern": "^[0-9A-Za-z.:/_-]+$",
           "maxLength": 80
          },
          "tokens": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000000000,
           "description": "token estimate removed from the transcript (every later request sends that much less)"
          },
          "runs": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000,
           "description": "compactions whose re-attached rows were rewritten"
          }
         },
         "required": [
          "model",
          "tokens",
          "runs"
         ],
         "additionalProperties": false
        }
       }
      },
      "required": [
       "route",
       "index",
       "compact"
      ],
      "additionalProperties": false
     },
     "time": {
      "type": "object",
      "description": "optional (plugin 0.7.0): the day's time figures on this computer, numbers only; never prompt text. typed_bytes = UTF-8 bytes of prompts a person typed (no tool results, command output, reminders, notifications, compaction summaries, pasted blocks, prompts from plugins or the system, or subagent transcripts); agent_seconds = clock time with at least one agent active (each transcript's events at most 10 minutes apart form an active interval; the union over every session and subagent, so overlaps count once); agent_sum_seconds = the same intervals added up (each session and subagent counted); turns = the turns counted",
      "properties": {
       "typed_bytes": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000000000
       },
       "agent_seconds": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000000
       },
       "agent_sum_seconds": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000000
       },
       "turns": {
        "type": "integer",
        "minimum": 0,
        "maximum": 10000000
       }
      },
      "required": [
       "typed_bytes",
       "agent_seconds",
       "agent_sum_seconds",
       "turns"
      ],
      "additionalProperties": false
     },
     "time_only": {
      "type": "boolean",
      "description": "optional (plugin 0.7.0): true = only refresh the time figures of a day already uploaded; the server then changes nothing but `time` on the stored day, and stores nothing when the day is not stored yet"
     }
    },
    "required": [
     "day",
     "client_version",
     "by_model",
     "by_task",
     "sessions"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "accepted": {
       "const": true
      }
     },
     "required": [
      "accepted"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "service_off",
     "not_in_plan",
     "consent_withdrawn",
     "consent_missing"
    ],
    "422": [
     "bad_request",
     "bad_day"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "one usage summary per day (numbers and hashes only); in return: cross-customer reports, savings amounts computed by the server, and tuning advice",
    "default": "off until the person turns the savings record on (/agent-services sharing on); /agent-services sharing off turns it off; /agent-services sharing preview shows the exact JSON of one upload",
    "retention": "13 months; deleted within 30 days of being turned off, or immediately from the settings page (DELETE /metrics)",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "DELETE",
   "path": "/metrics",
   "request": null,
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "deleted": {
       "type": "integer",
       "minimum": 0
      }
     },
     "required": [
      "deleted"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "immediately delete all of this customer's usage summaries on the server",
    "default": "sent only when the customer clicks delete",
    "retention": "no content stored; deletion record (client_id, time, row count) kept 13 months",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "GET",
   "path": "/report",
   "request": null,
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "generated": {
       "type": "string",
       "maxLength": 32
      },
      "window": {
       "type": "object",
       "properties": {
        "first_day": {
         "type": "string",
         "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
         "maxLength": 10
        },
        "last_day": {
         "type": "string",
         "pattern": "^\\d{4}-\\d{2}-\\d{2}$",
         "maxLength": 10
        },
        "days": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000000
        }
       },
       "required": [
        "first_day",
        "last_day",
        "days"
       ],
       "additionalProperties": false
      },
      "lines": {
       "type": "array",
       "maxItems": 40,
       "items": {
        "type": "object",
        "properties": {
         "id": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9_]{0,39}$",
          "maxLength": 40,
          "description": "id of a fixed template"
         },
         "values": {
          "type": "object",
          "description": "template parameters: numbers, or strings from a fixed set (dates, model ids, savings item names)"
         },
         "text": {
          "type": "string",
          "maxLength": 300
         }
        },
        "required": [
         "id",
         "values",
         "text"
        ],
        "additionalProperties": false
       }
      }
     },
     "required": [
      "generated",
      "window",
      "lines"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ],
    "404": [
     "no_report"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "fetch the cross-customer reports; sends no content",
    "default": "available at any time (existing reports can still be fetched after usage upload is turned off)",
    "retention": "no content stored; access log kept 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "GET",
   "path": "/metrics/savings",
   "request": null,
   "responses": {
    "200": {
     "$ref": "#/definitions/Savings"
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "saved amounts computed on the server from the uploaded counters",
    "default": "only while the metrics upload is on",
    "retention": "nothing stored; access log 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/metrics/weekly-mail",
   "request": {
    "type": "object",
    "properties": {
     "on": {
      "type": "boolean",
      "description": "false = stop the weekly savings email; true = send it again"
     }
    },
    "required": [
     "on"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "on": {
       "type": "boolean"
      }
     },
     "required": [
      "on"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "400": [
     "bad_json"
    ],
    "403": [
     "not_in_plan"
    ],
    "422": [
     "bad_request"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "turn the weekly savings email on or off",
    "default": "off; sent only when the customer turns the weekly savings email off or back on (the email itself is on by default for customers with the usage upload on)",
    "retention": "the setting and the time it changed, kept while the account exists; audit record 13 months",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/privacy/consent",
   "request": {
    "type": "object",
    "properties": {
     "purpose": {
      "enum": [
       "usage_upload"
      ],
      "description": "the plugin records only the savings record's upload choice"
     },
     "granted": {
      "type": "boolean",
      "description": "true = the person turned the daily upload on; false = turned it off"
     }
    },
    "required": [
     "purpose",
     "granted"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "purpose": {
       "type": "string",
       "maxLength": 40
      },
      "granted": {
       "type": "boolean"
      },
      "text_version": {
       "type": "string",
       "maxLength": 32
      }
     },
     "required": [
      "purpose",
      "granted"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "400": [
     "bad_json"
    ],
    "422": [
     "bad_request"
    ],
    "429": [
     "rate_limited"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "record the person's daily-upload choice on the server as a consent record (granted or withdrawn), so the server refuses uploads without it",
    "default": "sent when the person changes the savings record (on or off), and once before the first upload when the server has no record of an earlier yes",
    "retention": "one row per change (account id, purpose, granted, time, text version), kept as proof for 3 years; audit record 13 months",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "GET",
   "path": "/org/summary",
   "request": null,
   "responses": {
    "200": {
     "$ref": "#/definitions/OrgSummary"
    }
   },
   "errors": {
    "403": [
     "not_in_plan",
     "not_org_admin"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "the company admin's board: the company's savings last week, each person's figure and devices or only the totals (the company's board view), seats, pause and savings settings; sends no content",
    "default": "only for an account the operator made its company's admin; fetched for the admin's private board while the board is allowed",
    "retention": "nothing stored; access log 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/org/summary-mail",
   "request": {
    "type": "object",
    "properties": {
     "on": {
      "type": "boolean",
      "description": "false = stop the weekly company summary email; true = send it again"
     }
    },
    "required": [
     "on"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "on": {
       "type": "boolean"
      }
     },
     "required": [
      "on"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "400": [
     "bad_json"
    ],
    "403": [
     "not_in_plan",
     "not_org_admin"
    ],
    "422": [
     "bad_request"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "the company admin turns the weekly company summary email on or off",
    "default": "off; sent only when the company admin turns the summary email off or back on",
    "retention": "the setting, kept while the company exists; audit record 13 months",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "GET",
   "path": "/org/me",
   "request": null,
   "responses": {
    "200": {
     "$ref": "#/definitions/OrgMe"
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "a member sees what the company admin's board shows about them: their own email address, device count and weekly savings figure, and the company settings that apply to them; sends no content",
    "default": "off; sent only when the person runs /agent-services company (and is not the company admin)",
    "retention": "nothing stored; access log 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/diagnostic/estimate",
   "request": {
    "$ref": "#/definitions/DiagEstimateRequest"
   },
   "responses": {
    "200": {
     "$ref": "#/definitions/DiagEstimate"
    }
   },
   "errors": {
    "400": [
     "bad_json"
    ],
    "403": [
     "not_in_plan",
     "service_off"
    ],
    "422": [
     "bad_request",
     "too_little_data"
    ],
    "429": [
     "rate_limited"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "purpose": "one-time usage aggregate for the free diagnostic; the server answers an estimated monthly saving (numbers only)",
    "default": "off; sent once, only after the exact body was shown and `--consent` given",
    "retention": "body not stored; a per-account count per UTC day kept 30 days; access log 30 days",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/router/decide",
   "request": {
    "type": "object",
    "properties": {
     "session_ref": {
      "$ref": "#/definitions/SessionRef"
     },
     "type_word": {
      "type": "string",
      "pattern": "^\\S*$",
      "maxLength": 32,
      "description": "first word of the subagent description, split on whitespace; the rest of the text is not sent"
     },
     "subagent_type": {
      "type": "string",
      "pattern": "^[A-Za-z0-9 _.:-]+$",
      "minLength": 1,
      "maxLength": 64
     },
     "requested_model": {
      "anyOf": [
       {
        "type": "string",
        "pattern": "^[A-Za-z0-9.\\[\\]_:-]+$",
        "maxLength": 64
       },
       {
        "type": "null"
       }
      ]
     },
     "requested_effort": {
      "anyOf": [
       {
        "enum": [
         "low",
         "medium",
         "high",
         "xhigh",
         "max"
        ]
       },
       {
        "type": "null"
       }
      ]
     },
     "harness": {
      "enum": [
       "claude-code",
       "opencode",
       "codex",
       "other"
      ]
     },
     "desc_len": {
      "type": "integer",
      "minimum": 0,
      "maximum": 100000
     },
     "dispatch_no": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000000,
      "description": "which subagent dispatch this is in the session"
     },
     "project_hash": {
      "anyOf": [
       {
        "type": "string",
        "pattern": "^[0-9a-f]{16}$",
        "maxLength": 16
       },
       {
        "type": "null"
       }
      ],
      "description": "HMAC(local salt, project); can group but cannot recover the project name"
     },
     "main_model": {
      "anyOf": [
       {
        "type": "string",
        "pattern": "^[A-Za-z0-9.\\[\\]_:-]+$",
        "maxLength": 64
       },
       {
        "type": "null"
       }
      ],
      "description": "the main session's model id; the routed model is capped at it (0.6.0; absent from older clients)"
     },
     "user_asked_review": {
      "type": "boolean",
      "description": "whether the person's latest message asked for a review, computed on the machine; the message text is not sent (0.6.0; absent from older clients)"
     },
     "strict": {
      "type": "boolean",
      "description": "true when the person turned on strict routing (a dispatch without a task type word is refused); absent or false: advice only, never refused for a missing word (0.6.2; absent from older clients)"
     },
     "scope": {
      "type": "object",
      "properties": {
       "kind": {
        "enum": [
         "code",
         "oneoff_fix",
         "ops_content",
         "script",
         "other"
        ]
       },
       "in_git": {
        "type": "boolean"
       },
       "requirements_clear": {
        "type": "boolean"
       },
       "testable": {
        "type": "boolean"
       },
       "files_expected": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "sessions_expected": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000
       },
       "modules_expected": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000
       },
       "unfamiliar_codebase": {
        "type": "boolean"
       }
      },
      "additionalProperties": false,
      "description": "optional: the planned work's shape as counts and flags, no text; only plan dispatches use it, and the answer comes back in hint (absent from older clients)"
     }
    },
    "required": [
     "session_ref",
     "type_word",
     "subagent_type",
     "requested_model",
     "requested_effort",
     "harness",
     "desc_len",
     "dispatch_no",
     "project_hash"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "decision": {
       "enum": [
        "route",
        "pass",
        "deny"
       ]
      },
      "model": {
       "anyOf": [
        {
         "enum": [
          "haiku",
          "opus",
          "sonnet"
         ]
        },
        {
         "type": "null"
        }
       ]
      },
      "effort": {
       "anyOf": [
        {
         "enum": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
         ]
        },
        {
         "type": "null"
        }
       ]
      },
      "reason": {
       "enum": [
        "r1",
        "r2",
        "r3",
        "r4",
        "r5",
        "r6",
        "r7"
       ]
      },
      "hint": {
       "anyOf": [
        {
         "type": "string",
         "maxLength": 2000
        },
        {
         "type": "null"
        }
       ]
      },
      "brief_rule": {
       "type": "string",
       "maxLength": 2000,
       "x-served": true,
       "description": "the speed-up suggestion the plugin adds itself, labelled, to the subagent brief"
      },
      "brief_forward": {
       "type": "string",
       "maxLength": 500,
       "x-served": true,
       "description": "a note that the plugin adds brief_rule itself, so the model does not copy it"
      }
     },
     "required": [
      "decision",
      "model",
      "effort",
      "reason",
      "hint",
      "brief_rule",
      "brief_forward"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "router",
    "purpose": "asks which model and effort to use before a subagent dispatch (sends only the first word of the task type, a count, the main model id and whether the latest message asked for a review; not the description or message text)",
    "default": "on (on by default while Services is on)",
    "retention": "counts per decision per day; request bodies not stored",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/checkpoint/timing",
   "request": {
    "type": "object",
    "properties": {
     "session_ref": {
      "$ref": "#/definitions/SessionRef"
     },
     "context_pct": {
      "type": "number",
      "minimum": 0,
      "maximum": 100
     },
     "turns": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000000
     },
     "tool_calls": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000000
     },
     "todos_done": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000000
     },
     "commits": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000000
     },
     "minutes": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000000
     },
     "context_tokens": {
      "type": "integer",
      "minimum": 0,
      "maximum": 10000000,
      "description": "0.7.6, optional: tokens in the context now"
     },
     "event": {
      "enum": [
       "module_done",
       "topic_switch",
       "milestone",
       "user_request"
      ],
      "description": "optional: the work event that prompted the question (absent from older clients)"
     }
    },
    "required": [
     "session_ref",
     "context_pct",
     "turns",
     "tool_calls",
     "todos_done",
     "commits",
     "minutes"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "now": {
       "type": "boolean"
      },
      "keep_lines": {
       "type": "array",
       "maxItems": 10,
       "items": {
        "type": "string",
        "maxLength": 300
       },
       "x-served": true
      }
     },
     "required": [
      "now",
      "keep_lines"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "checkpoint",
    "purpose": "asks whether now is a good time to compact the context (sends only counters)",
    "default": "on (on by default while Services is on)",
    "retention": "counts per decision per day; request bodies not stored",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/limits/run",
   "request": {
    "type": "object",
    "properties": {
     "session_ref": {
      "$ref": "#/definitions/SessionRef"
     },
     "head": {
      "type": "string",
      "pattern": "^[a-z0-9._+-]+$",
      "minLength": 1,
      "maxLength": 40,
      "description": "first word of the command (if it is in the public list of common commands, otherwise other); arguments and paths are not sent"
     },
     "project_hash": {
      "anyOf": [
       {
        "type": "string",
        "pattern": "^[0-9a-f]{16}$",
        "maxLength": 16
       },
       {
        "type": "null"
       }
      ]
     },
     "prior_durations": {
      "type": "array",
      "maxItems": 5,
      "items": {
       "type": "number",
       "minimum": 0,
       "maximum": 604800
      }
     }
    },
    "required": [
     "session_ref",
     "head",
     "project_hash",
     "prior_durations"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "idle_seconds": {
       "type": "number",
       "minimum": 1,
       "maximum": 86400
      },
      "max_seconds": {
       "type": "number",
       "minimum": 0,
       "maximum": 604800,
       "description": "0 = no limit"
      }
     },
     "required": [
      "idle_seconds",
      "max_seconds"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "403": [
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "limits",
    "purpose": "bounded runs (boundrun) ask how long this command may go without output before it stops, and what its total time limit is",
    "default": "on (on by default while Services is on)",
    "retention": "counts per decision per day; request bodies not stored",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/dist/token",
   "request": {
    "type": "object",
    "properties": {
     "client_version": {
      "$ref": "#/definitions/Version"
     }
    },
    "required": [
     "client_version"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "token": {
       "type": "string",
       "pattern": "^ghs_[A-Za-z0-9_]{16,251}$",
       "maxLength": 255
      },
      "expires_at": {
       "type": "string",
       "pattern": "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z$",
       "maxLength": 20
      }
     },
     "required": [
      "token",
      "expires_at"
     ],
     "additionalProperties": false
    }
   },
   "errors": {
    "401": [
     "license_inactive"
    ],
    "403": [
     "no_license",
     "not_in_plan"
    ],
    "422": [
     "bad_request"
    ],
    "429": [
     "rate_limited"
    ],
    "502": [
     "scope_mismatch",
     "github_error"
    ],
    "503": [
     "dist_unavailable",
     "github_unreachable"
    ]
   },
   "x-response-secret": [
    "token"
   ],
   "x-inventory": {
    "service": "updates",
    "purpose": "read-only token for plugin updates (expires after 1 hour); sends only the client version",
    "default": "on",
    "retention": "sha256 of the token, account, device, time and expiry, kept 30 days; the token itself is not stored",
    "sent_to": [
     "our_service"
    ]
   }
  }
 ]
}
// end of CONTRACT
