import { defineSettings, stringSetting } from "../../settings/index.ts";

export const settings = defineSettings("brave", {
	apiKey: stringSetting({
		description: "Subscription token for Brave web search. Public-page reads require no token.",
		env: "PI_BRAVE_API_KEY",
		secret: true,
		validate: (value) => value.trim().length > 0,
	}),
});
