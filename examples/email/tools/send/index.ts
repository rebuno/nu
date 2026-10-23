import { type Compose, type Config, send } from "../../lib/mail.ts";

export default (args: Compose, { config }: { config: Config }) =>
  send(config, args);
