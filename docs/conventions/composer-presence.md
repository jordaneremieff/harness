# Composer presence

The ordinary Pi extension bus carries one presentation fact. The Markdown
composer publishes it; the statusline uses it to avoid a duplicate footer.
Neither extension imports the other or transfers ownership of a UI slot.

| Event | Payload | Meaning |
| --- | --- | --- |
| `harness:composer:presence` | `{ version: 1, present: boolean }` | A present **and visible** composer replaces the terminal input. `false` restores the terminal presentation. |
| `harness:composer:presence-request` | `{ version: 1 }` | Request the current value on the same bus. |

The composer publishes when the value changes and answers a valid request
synchronously. The initial value is `false`. Hide, poll gaps, and disposal of
the composer restore `false`; a new or reattached composer publishes `true`
only when it replaces terminal entry. The statusline subscribes before it
requests the current value at `session_start`. It renders no footer lines
while the value is `true`, and otherwise renders its usual footer. An absent
publisher or invalid payload does not suppress the footer.

The event bus belongs to the current ordinary extension runtime. Each slice
validates the version and the fields it consumes and removes its subscription
at `session_shutdown`. These events do not persist or grant control of the
composer.
