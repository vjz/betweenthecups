export type Star = {
  id: string;
  name: string;
  country: string;
  tier: 3 | 4 | 5;
  teamId: string;
  tags: string[];
  aliases: string[];
  status: "active" | "verify";
};

export type Team = {
  id: string;
  name: string;
  aliases: string[];
  country: string;
  competition: string;
  fixtureApiIds: Record<string, string | number>;
  defaultUsBroadcasters: string[];
  status: "active" | "verify";
};

export type GeneratedMatch = {
  id: string;
  kickoffUtc: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  starNames: string[];
  whyWatch: string;
  watchUs: string[];
  score: number;
  excitement: 1 | 2 | 3 | 4 | 5;
};

export type MatchSection = {
  id: "today" | "week" | "month" | "horizon";
  label: string;
  description: string;
  matches: GeneratedMatch[];
};

export type DailyMatches = {
  generatedAt: string;
  date: string;
  timezone: string;
  source: "sample" | "fixture-api";
  matches?: GeneratedMatch[];
  sections: MatchSection[];
};
