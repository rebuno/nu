import { type Compose, type Config, draft } from "../../lib/mail.ts";

export default (args: Compose, { config }: { config: Config }) =>
  draft(config, args);
