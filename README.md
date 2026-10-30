# agent-services

agent-services is a Claude Code plugin. It connects Claude Code's hook events (subagent dispatch, tool calls,
checkpoints and usage) to a small local core that runs on your own machine.

Every service call needs a logged-in account. Without one the plugin runs only its open defaults: hooks pass
through unchanged, nothing is sent anywhere, and the local tools keep working.

## Install

In Claude Code:

```
/plugin marketplace add <this repository>
/plugin install agent-services
```

Then log in from the plugin's own login command to turn the services on.

## License

All rights reserved; see `LICENSE`. The terms of use are in the end-user license agreement shipped by the installer.
