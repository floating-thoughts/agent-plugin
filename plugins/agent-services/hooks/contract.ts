
export type ToolSpec = {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export const CONTRACT_SHA256 = "23aca72ada3ca89c727dc8e99dc0354638573793f4ff43ab93b8dc29e621b5ea"

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
export const TOOL_NAMES = ["savings", "toolbox", "status"] as const

export const TOOLS: readonly ToolSpec[] = [
  {
    "name": "savings",
    "description": "Show what the agent services saved so far: the estimated dollars saved by routing subagents to cheaper models (compared with running them on Opus), by checkpoint compactions, by indexed file reads and by trimmed attachments, worked out by the service from the daily usage summaries of the local savings log. By default a short summary (a few hundred tokens): the total and each lever, the last 7 days one line each, the best days, any day whose figure is a loss (labelled, not netted silently) and notes on days with incomplete counts. detail \"full\" returns the whole day-by-day history (large: ask for it only when needed); the private savings page shows the full view too. Returns local_only when the service cannot be reached.",
    "input_schema": {
      "type": "object",
      "properties": {
        "detail": {
          "type": "string",
          "enum": [
            "summary",
            "full"
          ],
          "description": "summary (default): the short summary; full: the whole day-by-day history"
        }
      },
      "required": [],
      "additionalProperties": false
    }
  },
  {
    "name": "toolbox",
    "description": "Fetch one agent-services toolbox pack by its key from the toolbox index (an agent-services suggestion: know-how for one tool or tool family, fetched only when the work needs it). Key \"index\" lists the index again (each key with one line saying when to fetch it). For branched-problems, pass topic (a pack key) to get only that topic's problem and fix pairs. Only the random session ref, the key and the topic are sent. Returns the pack's items wrapped in <agent-pack>, or no_toolbox when the service has no toolbox for this account.",
    "input_schema": {
      "type": "object",
      "properties": {
        "key": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,39}$",
          "maxLength": 40
        },
        "topic": {
          "type": "string",
          "pattern": "^[a-z][a-z0-9-]{1,39}$",
          "maxLength": 40
        }
      },
      "required": [
        "key"
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

export const CONTRACT = {
 "api": "svc/1",
 "prefix": "/svc/v1",
 "x-tools": [
  {
   "name": "savings",
   "description": "Show what the agent services saved so far: the estimated dollars saved by routing subagents to cheaper models (compared with running them on Opus), by checkpoint compactions, by indexed file reads and by trimmed attachments, worked out by the service from the daily usage summaries of the local savings log. By default a short summary (a few hundred tokens): the total and each lever, the last 7 days one line each, the best days, any day whose figure is a loss (labelled, not netted silently) and notes on days with incomplete counts. detail \"full\" returns the whole day-by-day history (large: ask for it only when needed); the private savings page shows the full view too. Returns local_only when the service cannot be reached.",
   "input_schema": {
    "type": "object",
    "properties": {
     "detail": {
      "type": "string",
      "enum": [
       "summary",
       "full"
      ],
      "description": "summary (default): the short summary; full: the whole day-by-day history"
     }
    },
    "required": [],
    "additionalProperties": false
   }
  },
  {
   "name": "toolbox",
   "description": "Fetch one agent-services toolbox pack by its key from the toolbox index (an agent-services suggestion: know-how for one tool or tool family, fetched only when the work needs it). Key \"index\" lists the index again (each key with one line saying when to fetch it). For branched-problems, pass topic (a pack key) to get only that topic's problem and fix pairs. Only the random session ref, the key and the topic are sent. Returns the pack's items wrapped in <agent-pack>, or no_toolbox when the service has no toolbox for this account.",
   "input_schema": {
    "type": "object",
    "properties": {
     "key": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,39}$",
      "maxLength": 40
     },
     "topic": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,39}$",
      "maxLength": 40
     }
    },
    "required": [
     "key"
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
 "x-core-tools": [
  {
   "name": "router_advice",
   "description": "Ask the routing service which model and effort a subagent dispatch should use. Sends only the first word of the description (max 32 chars) and its length, the subagent type, the requested model and effort, the harness name, a random session ref, the dispatch count, a salted project hash and, when known, the main model, whether the user asked for a review, at strict whether the user wrote override, whether strict routing is on, the allowed models and efforts, the session pick and the optional scope; the description text stays on this machine. Returns decision (route, pass or deny), model, effort, hint, brief_rule (added by the plugin; do not copy it), note and, with table true, the routing table for this session. At level suggest an explicit model and effort are honoured within the allowed set; at strict the table decides unless the user wrote override. pass_through when unreachable. On a plan, replan or acceptance dispatch, pass scope (counts and flags, no text) for a size hint.",
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
     "table": {
      "type": "boolean",
      "description": "also return the routing table as text in table"
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
   "description": "Fetch the served lessons for a role and a work phase (plan, implement, test, review, deliver, checkpoint). Returns the version, the catalog line, the items and the rule for using them; an empty list when nothing is served. Pass event (resume, module_start, ui, index_request, delivery) to get only the just-in-time items of that moment by name; only the event name is sent.",
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
     },
     "event": {
      "type": "string",
      "enum": [
       "resume",
       "module_start",
       "ui",
       "index_request",
       "delivery"
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
  }
 ],
 "definitions": {
  "SessionRef": {
   "type": "string",
   "pattern": "^[0-9a-f]{32}$",
   "maxLength": 32
  },
  "SessionKind": {
   "enum": [
    "auto",
    "direct"
   ]
  },
  "Sha256": {
   "type": "string",
   "pattern": "^[0-9a-f]{64}$",
   "maxLength": 64
  },
  "SessionMark": {
   "type": "string",
   "pattern": "^[a-z]{2,8}-[0-9a-f]{16,32}$",
   "maxLength": 41
  },
  "SessionTag": {
   "type": "string",
   "pattern": "^[a-z]{2,8}-[0-9a-f]{16,32}$",
   "maxLength": 41
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
   ]
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
  "ServedEvent": {
   "enum": [
    "resume",
    "module_start",
    "ui",
    "index_request",
    "delivery"
   ]
  },
  "OrgSummary": {
   "type": "object",
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
    "api_usd": {
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
    "prev_api_usd": {
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
    "sessions": {
     "anyOf": [
      {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000000
      },
      {
       "type": "null"
      }
     ]
    },
    "prev_sessions": {
     "anyOf": [
      {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000000
      },
      {
       "type": "null"
      }
     ]
    },
    "subagent_runs": {
     "anyOf": [
      {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000000
      },
      {
       "type": "null"
      }
     ]
    },
    "prev_subagent_runs": {
     "anyOf": [
      {
       "type": "integer",
       "minimum": 0,
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
    "in_week": {
     "type": "integer",
     "minimum": 0,
     "maximum": 1000000
    },
    "people_withheld": {
     "type": "boolean"
    },
    "codex": {
     "type": "object",
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
      "tokens": {
       "type": "integer",
       "minimum": 0,
       "maximum": 1000000000000000
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
    },
    "people_withheld": {
     "type": "boolean"
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
  "OrgMembers": {
   "type": "object",
   "properties": {
    "org": {
     "type": "string",
     "maxLength": 200
    },
    "view": {
     "enum": [
      "totals",
      "members"
     ]
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
    "members": {
     "type": "array",
     "maxItems": 10000,
     "items": {
      "type": "object",
      "properties": {
       "email": {
        "type": "string",
        "maxLength": 254
       },
       "role": {
        "enum": [
         "admin",
         "member"
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
       "role",
       "devices"
      ],
      "additionalProperties": false
     }
    }
   },
   "required": [
    "org",
    "view",
    "seats_used",
    "seats_paid",
    "members"
   ],
   "additionalProperties": false
  },
  "OrgSavings": {
   "enum": [
    "each",
    "on",
    "off"
   ]
  },
  "Savings": {
   "type": "object",
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
     "$ref": "#/definitions/Lever"
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
       },
       "sessions": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000000
       },
       "subagent_runs": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000000
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
    },
    "usage_by_day": {
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
       "tokens": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000000000000000
       },
       "api_usd": {
        "type": "number",
        "minimum": 0,
        "maximum": 1000000000
       },
       "mine": {
        "type": "boolean"
       },
       "mine_tokens": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000000000000000
       },
       "mine_api_usd": {
        "type": "number",
        "minimum": 0,
        "maximum": 1000000000
       },
       "legacy_tokens": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000000000000000
       },
       "legacy_api_usd": {
        "type": "number",
        "minimum": 0,
        "maximum": 1000000000
       }
      },
      "required": [
       "day",
       "tokens",
       "api_usd",
       "mine",
       "mine_tokens",
       "mine_api_usd",
       "legacy_tokens",
       "legacy_api_usd"
      ],
      "additionalProperties": false
     }
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
    "default": "on",
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
      ]
     },
     "channel": {
      "enum": [
       "stable",
       "beta"
      ]
     },
     "state": {
      "type": "object",
      "properties": {
       "exists": {
        "type": "boolean"
       },
       "running": {
        "type": "boolean"
       },
       "goal": {
        "type": "boolean"
       },
       "plan_steps": {
        "type": "integer",
        "minimum": 0,
        "maximum": 1000
       },
       "level": {
        "enum": [
         "on",
         "suggest"
        ]
       }
      },
      "required": [
       "exists",
       "running",
       "goal",
       "plan_steps",
       "level"
      ],
      "additionalProperties": false
     },
     "jit": {
      "type": "boolean"
     },
     "event": {
      "$ref": "#/definitions/ServedEvent"
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
       ]
      },
      "pinned": {
       "type": "boolean"
      },
      "catalog": {
       "type": "string",
       "maxLength": 200
      },
      "items": {
       "type": "array",
       "maxItems": 1000,
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
      },
      "gate": {
       "type": "object",
       "properties": {
        "hold": {
         "type": "boolean"
        },
        "reason": {
         "type": "string",
         "maxLength": 4000,
         "x-served": true
        },
        "small_edit_lines": {
         "type": "integer",
         "minimum": 0,
         "maximum": 1000
        }
       },
       "required": [
        "hold",
        "reason"
       ],
       "additionalProperties": false
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
    "default": "on",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/toolbox/fetch",
   "request": {
    "type": "object",
    "properties": {
     "session_ref": {
      "$ref": "#/definitions/SessionRef"
     },
     "pack": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,39}$",
      "maxLength": 40
     },
     "topic": {
      "type": "string",
      "pattern": "^[a-z][a-z0-9-]{1,39}$",
      "maxLength": 40
     }
    },
    "required": [
     "session_ref",
     "pack"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "anyOf": [
      {
       "type": "object",
       "properties": {
        "kind": {
         "const": "index"
        },
        "version": {
         "type": "string",
         "pattern": "^[0-9a-f]{12}$",
         "maxLength": 12
        },
        "note": {
         "type": "string",
         "maxLength": 1500,
         "x-served": true
        },
        "entries": {
         "type": "array",
         "maxItems": 64,
         "items": {
          "type": "object",
          "properties": {
           "key": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9-]{1,39}$",
            "maxLength": 40
           },
           "when": {
            "type": "string",
            "minLength": 1,
            "maxLength": 2000,
            "x-served": true
           }
          },
          "required": [
           "key",
           "when"
          ],
          "additionalProperties": false
         }
        }
       },
       "required": [
        "kind",
        "version",
        "note",
        "entries"
       ],
       "additionalProperties": false
      },
      {
       "type": "object",
       "properties": {
        "kind": {
         "const": "pack"
        },
        "key": {
         "type": "string",
         "pattern": "^[a-z][a-z0-9-]{1,39}$",
         "maxLength": 40
        },
        "title": {
         "type": "string",
         "minLength": 1,
         "maxLength": 60,
         "x-served": true
        },
        "version": {
         "$ref": "#/definitions/Version"
        },
        "items": {
         "type": "array",
         "maxItems": 500,
         "items": {
          "type": "object",
          "properties": {
           "id": {
            "type": "string",
            "pattern": "^[a-z0-9][a-z0-9-]{0,63}$",
            "maxLength": 64
           },
           "text": {
            "type": "string",
            "minLength": 1,
            "maxLength": 20000,
            "x-served": true
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
        },
        "branched": {
         "type": "integer",
         "minimum": 0,
         "maximum": 100000
        }
       },
       "required": [
        "kind",
        "key",
        "title",
        "version",
        "items",
        "branched"
       ],
       "additionalProperties": false
      }
     ]
    }
   },
   "errors": {
    "404": [
     "no_such_pack"
    ],
    "409": [
     "session_required"
    ],
    "403": [
     "no_license",
     "not_in_plan"
    ]
   },
   "x-inventory": {
    "service": "updates",
    "default": "on (the index once per session and after a compaction; a pack only when the model asks for it)",
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
       "$ref": "#/definitions/SessionMark"
      },
      "canaries": {
       "type": "array",
       "minItems": 1,
       "maxItems": 4,
       "uniqueItems": true,
       "items": {
        "$ref": "#/definitions/SessionTag"
       }
      },
      "fp": {
       "type": "object",
       "properties": {
        "key": {
         "$ref": "#/definitions/Sha256"
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
    "default": "on (once when the session opens; not sent when served content is turned off)",
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
     },
     "contact": {
      "type": "boolean"
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
       ]
      },
      "support_contact": {
       "type": "string",
       "minLength": 3,
       "maxLength": 254,
       "pattern": "^[^@ ]+@[^@ ]+$"
      },
      "tables": {
       "type": "object"
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
    "default": "on (once when a signed-in session starts)",
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
      "maxLength": 300
     },
     "error_sha256": {
      "$ref": "#/definitions/Sha256"
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
      ]
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
    "default": "off (the customer turns it on)",
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
         "maxLength": 20
        },
        "model": {
         "type": "string",
         "pattern": "^[0-9A-Za-z.:/_-]+$",
         "maxLength": 80
        },
        "project_hash": {
         "type": "string",
         "pattern": "^[0-9a-f]{16}$",
         "maxLength": 16
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
         ]
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
      "properties": {
       "route": {
        "type": "array",
        "maxItems": 100,
        "items": {
         "type": "object",
         "properties": {
          "model": {
           "type": "string",
           "pattern": "^[0-9A-Za-z.:/_-]+$",
           "maxLength": 80
          },
          "long": {
           "type": "boolean"
          },
          "main_model": {
           "type": "string",
           "pattern": "^[0-9A-Za-z.:/_-]+$",
           "maxLength": 80
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
           "maximum": 1000000000
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
        "items": {
         "type": "object",
         "properties": {
          "ref": {
           "type": "string",
           "pattern": "^[0-9a-f]{16}$",
           "maxLength": 16
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
           ]
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
           "maximum": 1000000000000
          },
          "runs": {
           "type": "integer",
           "minimum": 0,
           "maximum": 1000000
          },
          "net": {
           "type": "boolean"
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
      "type": "boolean"
     },
     "overhead": {
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
        }
       },
       "required": [
        "model",
        "input_tokens"
       ],
       "additionalProperties": false
      }
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
    "default": "off until the person turns the savings record on (/agent-services sharing on); /agent-services sharing off turns it off; /agent-services sharing preview shows the exact JSON of one upload",
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
    "default": "sent only when the customer clicks delete",
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
          "maxLength": 40
         },
         "values": {
          "type": "object"
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
    "default": "available at any time (existing reports can still be fetched after usage upload is turned off)",
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
    "default": "only while the metrics upload is on",
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
      "type": "boolean"
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
    "default": "off; sent only when the customer turns the weekly savings email off or back on (the email itself is on by default for customers with the usage upload on)",
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
      ]
     },
     "granted": {
      "type": "boolean"
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
    "default": "sent when the person changes the savings record (on or off), and once before the first upload when the server has no record of an earlier yes",
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
    "default": "only for an account the operator made its company's admin; fetched for the admin's private board while the board is allowed",
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
      "type": "boolean"
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
    "default": "off; sent only when the company admin turns the summary email off or back on",
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
    "default": "off; sent only when the person asks Claude what the admin sees about them, through the setup tool's \"company view\" (and is not the company admin)",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "GET",
   "path": "/org/members",
   "request": null,
   "responses": {
    "200": {
     "$ref": "#/definitions/OrgMembers"
    }
   },
   "errors": {
    "403": [
     "not_in_plan",
     "not_org_admin",
     "no_license"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "default": "only for an account the operator made its company's admin; fetched when the admin opens the member list",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/org/members",
   "request": {
    "type": "object",
    "properties": {
     "email": {
      "type": "string",
      "maxLength": 254
     },
     "notice_given": {
      "type": "boolean",
      "const": true
     }
    },
    "required": [
     "email",
     "notice_given"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "added": {
       "type": "boolean",
       "const": true
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
      }
     },
     "required": [
      "added",
      "seats_used",
      "seats_paid"
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
     "not_org_admin",
     "no_license"
    ],
    "409": [
     "no_free_seat",
     "already_member",
     "not_added"
    ],
    "422": [
     "bad_request"
    ],
    "429": [
     "rate_limited",
     "day_limit"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "default": "off; sent only when the company admin adds a member",
    "sent_to": [
     "our_service"
    ]
   }
  },
  {
   "method": "POST",
   "path": "/org/members/remove",
   "request": {
    "type": "object",
    "properties": {
     "email": {
      "type": "string",
      "maxLength": 254
     }
    },
    "required": [
     "email"
    ],
    "additionalProperties": false
   },
   "responses": {
    "200": {
     "type": "object",
     "properties": {
      "removed": {
       "type": "boolean",
       "const": true
      },
      "signed_out": {
       "type": "integer",
       "minimum": 0,
       "maximum": 100000
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
      }
     },
     "required": [
      "removed",
      "signed_out",
      "seats_used",
      "seats_paid"
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
     "not_org_admin",
     "no_license"
    ],
    "409": [
     "not_removed"
    ],
    "422": [
     "bad_request"
    ],
    "429": [
     "rate_limited",
     "day_limit"
    ]
   },
   "x-inventory": {
    "service": "metrics",
    "default": "off; sent only when the company admin removes a member",
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
    "default": "off; sent once, only after the exact body was shown and `--consent` given",
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
      "maxLength": 32
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
      "maximum": 1000000
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
      ]
     },
     "user_asked_review": {
      "type": "boolean"
     },
     "user_asked_override": {
      "type": "boolean"
     },
     "plan_done": {
      "type": "boolean"
     },
     "prior_failures": {
      "type": "integer",
      "minimum": 0,
      "maximum": 1000
     },
     "strict": {
      "type": "boolean"
     },
     "allowed": {
      "type": "object",
      "properties": {
       "models": {
        "type": "array",
        "minItems": 1,
        "maxItems": 4,
        "uniqueItems": true,
        "items": {
         "enum": [
          "fable",
          "opus",
          "sonnet",
          "haiku"
         ]
        }
       },
       "efforts": {
        "type": "array",
        "minItems": 1,
        "maxItems": 5,
        "uniqueItems": true,
        "items": {
         "enum": [
          "low",
          "medium",
          "high",
          "xhigh",
          "max"
         ]
        }
       },
       "top": {
        "type": "object",
        "properties": {
         "model": {
          "enum": [
           "fable",
           "opus",
           "sonnet",
           "haiku"
          ]
         },
         "effort": {
          "enum": [
           "low",
           "medium",
           "high",
           "xhigh",
           "max"
          ]
         }
        },
        "required": [
         "model",
         "effort"
        ],
        "additionalProperties": false
       }
      },
      "required": [
       "models",
       "efforts"
      ],
      "additionalProperties": false
     },
     "explain": {
      "type": "boolean"
     },
     "user_pick": {
      "type": "object",
      "properties": {
       "model": {
        "enum": [
         "fable",
         "opus",
         "sonnet",
         "haiku"
        ]
       },
       "effort": {
        "enum": [
         "low",
         "medium",
         "high",
         "xhigh",
         "max"
        ]
       },
       "words": {
        "type": "array",
        "maxItems": 16,
        "uniqueItems": true,
        "items": {
         "type": "string",
         "pattern": "^[a-z-]{1,32}$",
         "maxLength": 32
        }
       }
      },
      "additionalProperties": false
     },
     "want_table": {
      "type": "boolean"
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
      "additionalProperties": false
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
          "sonnet",
          "fable"
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
       "x-served": true
      },
      "brief_forward": {
       "type": "string",
       "maxLength": 500,
       "x-served": true
      },
      "note": {
       "type": "string",
       "maxLength": 400,
       "x-served": true
      },
      "table": {
       "type": "string",
       "maxLength": 2000,
       "x-served": true
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
    "default": "on (on by default while Services is on)",
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
      "maximum": 10000000
     },
     "event": {
      "enum": [
       "module_done",
       "topic_switch",
       "milestone",
       "user_request"
      ]
     },
     "turn": {
      "type": "object",
      "properties": {
       "reads": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "searches": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "web": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "lookup_run": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "shell_kchars": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "read_kchars": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "denials": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "same_failure": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "steps_ready": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "subagents_dispatched": {
        "type": "integer",
        "minimum": 0,
        "maximum": 100000
       },
       "foreground_seconds": {
        "type": "integer",
        "minimum": 0,
        "maximum": 604800
       },
       "history": {
        "type": "array",
        "maxItems": 8,
        "items": {
         "type": "object",
         "properties": {
          "case": {
           "enum": [
            "denied",
            "repeat_failure",
            "steps",
            "background",
            "big_output",
            "wide_read",
            "web"
           ]
          },
          "ago": {
           "type": "integer",
           "minimum": 0,
           "maximum": 100000
          },
          "times": {
           "type": "integer",
           "minimum": 0,
           "maximum": 100000
          }
         },
         "required": [
          "case",
          "ago",
          "times"
         ],
         "additionalProperties": false
        }
       }
      },
      "additionalProperties": false
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
      },
      "note": {
       "type": "string",
       "maxLength": 1500,
       "x-served": true
      },
      "cases": {
       "type": "array",
       "maxItems": 8,
       "items": {
        "enum": [
         "denied",
         "repeat_failure",
         "steps",
         "background",
         "big_output",
         "wide_read",
         "web"
        ]
       }
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
    "default": "on (on by default while Services is on)",
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
      "maxLength": 40
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
       "maximum": 604800
      },
      "background": {
       "type": "boolean"
      },
      "note": {
       "type": "string",
       "maxLength": 600,
       "x-served": true
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
    "default": "on (on by default while Services is on)",
    "sent_to": [
     "our_service"
    ]
   }
  }
 ]
}
