import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { DailyMatches, GeneratedMatch, MatchSection, Star, Team } from "../src/lib/types";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STARS_PATH = path.join(ROOT, "data", "curated", "stars.json");
const TEAMS_PATH = path.join(ROOT, "data", "curated", "teams.json");
const FIXTURE_SOURCES_PATH = path.join(ROOT, "data", "curated", "fixture-sources.json");
const LATEST_PATH = path.join(ROOT, "data", "generated", "latest.json");
const FIXTURE_CACHE_DIR = path.join(ROOT, "data", "cache", "fixtures");

type FixtureSource = {
  id: string;
  provider: "espn";
  leagueSlug: string;
  competition: string;
};

type EspnEvent = {
  id: string;
  date: string;
  name: string;
  competitions?: Array<{
    broadcasts?: Array<{ names?: string[] }>;
    competitors?: Array<{
      homeAway: "home" | "away";
      team: {
        id?: string;
        displayName?: string;
        name?: string;
        shortDisplayName?: string;
      };
    }>;
  }>;
};

type NormalizedFixture = {
  id: string;
  source: string;
  sourceLeague: string;
  kickoffUtc: string;
  competition: string;
  homeTeam: string;
  awayTeam: string;
  homeTeamId?: string;
  awayTeamId?: string;
  trackedTeamIds: string[];
  broadcasts: string[];
};

type CliArgs = {
  command: string;
  date: string;
  days: number;
};

function parseArgs(): CliArgs {
  const args = process.argv.slice(2);
  const command = args[0] ?? "help";
  const dateIndex = args.indexOf("--date");
  const daysIndex = args.indexOf("--days");
  const date = dateIndex >= 0 ? args[dateIndex + 1] ?? "today" : "today";
  const days = daysIndex >= 0 ? Number(args[daysIndex + 1] ?? 180) : 180;
  return { command, date, days: Number.isFinite(days) ? days : 180 };
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf8")) as T;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

function localDate(input: string): string {
  if (input === "today") {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }
  assert(/^\d{4}-\d{2}-\d{2}$/.test(input), `Invalid --date ${input}; expected YYYY-MM-DD or today`);
  return input;
}

function addDays(date: string, days: number): string {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

function compactDate(date: string): string {
  return date.replaceAll("-", "");
}

function validateStars(stars: Star[], teamIds: Set<string>): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const star of stars) {
    if (ids.has(star.id)) errors.push(`Duplicate star id: ${star.id}`);
    ids.add(star.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(star.id)) errors.push(`Bad star id: ${star.id}`);
    if (!star.name) errors.push(`Missing star name for ${star.id}`);
    if (![3, 4, 5].includes(star.tier)) errors.push(`Invalid tier for ${star.id}: ${star.tier}`);
    if (!teamIds.has(star.teamId)) errors.push(`Unknown teamId for ${star.id}: ${star.teamId}`);
    if (!Array.isArray(star.aliases)) errors.push(`aliases must be an array for ${star.id}`);
    if (!["active", "verify"].includes(star.status)) errors.push(`Invalid status for ${star.id}: ${star.status}`);
  }
  return errors;
}

function validateTeams(teams: Team[]): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const team of teams) {
    if (ids.has(team.id)) errors.push(`Duplicate team id: ${team.id}`);
    ids.add(team.id);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(team.id)) errors.push(`Bad team id: ${team.id}`);
    if (!team.name) errors.push(`Missing team name for ${team.id}`);
    if (!Array.isArray(team.aliases) || team.aliases.length === 0) errors.push(`Missing aliases for ${team.id}`);
    if (!team.competition) errors.push(`Missing competition for ${team.id}`);
    if (!["active", "verify"].includes(team.status)) errors.push(`Invalid status for ${team.id}: ${team.status}`);
  }
  return errors;
}

function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(fc|cf|sc|club)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function findTrackedTeam(apiName: string, teams: Team[]): Team | undefined {
  const normalizedApiName = normalizeText(apiName);
  return teams.find((team) => {
    const candidates = [team.name, ...team.aliases];
    return candidates.some((candidate) => {
      const normalizedCandidate = normalizeText(candidate);
      return normalizedApiName === normalizedCandidate;
    });
  });
}

function eventBroadcasts(event: EspnEvent): string[] {
  const names = new Set<string>();
  for (const competition of event.competitions ?? []) {
    for (const broadcast of competition.broadcasts ?? []) {
      for (const name of broadcast.names ?? []) {
        if (name.trim()) names.add(name.trim());
      }
    }
  }
  return [...names];
}

function normalizeEspnEvent(event: EspnEvent, source: FixtureSource, teams: Team[]): NormalizedFixture | null {
  const competition = event.competitions?.[0];
  const competitors = competition?.competitors ?? [];
  const home = competitors.find((competitor) => competitor.homeAway === "home");
  const away = competitors.find((competitor) => competitor.homeAway === "away");
  const homeName = home?.team.displayName ?? home?.team.name;
  const awayName = away?.team.displayName ?? away?.team.name;
  if (!homeName || !awayName) return null;

  const homeTracked = findTrackedTeam(homeName, teams);
  const awayTracked = findTrackedTeam(awayName, teams);
  const trackedTeamIds = [homeTracked?.id, awayTracked?.id].filter((id): id is string => Boolean(id));
  if (trackedTeamIds.length === 0) return null;

  return {
    id: `espn-${event.id}`,
    source: "espn",
    sourceLeague: source.leagueSlug,
    kickoffUtc: event.date,
    competition: source.competition,
    homeTeam: homeName,
    awayTeam: awayName,
    homeTeamId: homeTracked?.id,
    awayTeamId: awayTracked?.id,
    trackedTeamIds,
    broadcasts: eventBroadcasts(event),
  };
}

async function fetchEspnSource(
  source: FixtureSource,
  startDate: string,
  endDate: string,
  teams: Team[],
): Promise<NormalizedFixture[]> {
  const espnDates = startDate === endDate ? compactDate(startDate) : `${compactDate(startDate)}-${compactDate(endDate)}`;
  const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${source.leagueSlug}/scoreboard?dates=${espnDates}`;
  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "user-agent": "BetweenTheCups/0.1 fixture fetcher",
    },
  });
  if (!response.ok) {
    throw new Error(`ESPN ${source.leagueSlug} returned ${response.status}`);
  }
  const payload = (await response.json()) as { events?: EspnEvent[] };
  return (payload.events ?? [])
    .map((event) => normalizeEspnEvent(event, source, teams))
    .filter((fixture): fixture is NormalizedFixture => Boolean(fixture));
}

async function fetchFixtures(dateInput: string): Promise<NormalizedFixture[]> {
  const date = localDate(dateInput);
  return fetchFixturesRange(date, date);
}

async function fetchFixturesRange(startDateInput: string, endDateInput: string): Promise<NormalizedFixture[]> {
  const startDate = localDate(startDateInput);
  const endDate = localDate(endDateInput);
  const { teams } = await loadCurated();
  const sources = await readJson<FixtureSource[]>(FIXTURE_SOURCES_PATH);
  const settled = await Promise.allSettled(sources.map((source) => fetchEspnSource(source, startDate, endDate, teams)));
  const fixtures = settled.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
  fixtures.sort((a, b) => a.kickoffUtc.localeCompare(b.kickoffUtc));
  await mkdir(FIXTURE_CACHE_DIR, { recursive: true });
  const cacheName = startDate === endDate ? `${startDate}.json` : `${startDate}_${endDate}.json`;
  await writeFile(
    path.join(FIXTURE_CACHE_DIR, cacheName),
    `${JSON.stringify({ startDate, endDate, fixtures }, null, 2)}\n`,
  );
  return fixtures;
}

function starsForFixture(fixture: NormalizedFixture, stars: Star[]): Star[] {
  const tracked = new Set(fixture.trackedTeamIds);
  return stars
    .filter((star) => tracked.has(star.teamId))
    .sort((a, b) => b.tier - a.tier || a.name.localeCompare(b.name));
}

function scoreFixture(fixture: NormalizedFixture, stars: Star[]): number {
  const tierScore = stars.reduce((total, star) => total + (star.tier === 5 ? 32 : star.tier === 4 ? 18 : 9), 0);
  const competitionQuality: Record<string, number> = {
    "Premier League": 18,
    "La Liga": 18,
    Bundesliga: 15,
    "Serie A": 15,
    "Ligue 1": 13,
    MLS: 9,
    Brasileirao: 9,
  };
  const hasTrackedTeamsOnBothSides = Boolean(fixture.homeTeamId && fixture.awayTeamId);
  const bothSidesTracked = hasTrackedTeamsOnBothSides ? 14 : 0;
  const manyStars = stars.length >= 3 ? 10 : stars.length >= 2 ? 5 : 0;
  const rawScore = tierScore + (competitionQuality[fixture.competition] ?? 8) + bothSidesTracked + manyStars;
  const oneSidedCap = stars.some((star) => star.tier === 5) ? 68 : 58;
  return Math.min(hasTrackedTeamsOnBothSides ? 100 : oneSidedCap, rawScore);
}

function whyWatch(fixture: NormalizedFixture, stars: Star[]): string {
  const names = stars.map((star) => star.name);
  if (fixture.homeTeamId && fixture.awayTeamId && names.length >= 2) {
    return `${fixture.homeTeam} and ${fixture.awayTeam} put ${names.slice(0, 4).join(", ")} in the same match.`;
  }
  if (names.length >= 2) {
    return `${fixture.homeTeam} vs ${fixture.awayTeam} features ${names.slice(0, 4).join(", ")} for World Cup fans.`;
  }
  if (names.length === 1) {
    return `Worth a look for ${names[0]}, with matchup quality deciding how high it ranks.`;
  }
  return `${fixture.homeTeam} vs ${fixture.awayTeam} is on the tracked-team slate.`;
}

function watchOptions(fixture: NormalizedFixture, teams: Team[]): string[] {
  const options = new Set(fixture.broadcasts);
  for (const teamId of fixture.trackedTeamIds) {
    const team = teams.find((candidate) => candidate.id === teamId);
    for (const broadcaster of team?.defaultUsBroadcasters ?? []) {
      options.add(broadcaster);
    }
  }
  return [...options];
}

async function loadCurated(): Promise<{ stars: Star[]; teams: Team[] }> {
  const [stars, teams] = await Promise.all([readJson<Star[]>(STARS_PATH), readJson<Team[]>(TEAMS_PATH)]);
  return { stars, teams };
}

async function validate(): Promise<void> {
  const { stars, teams } = await loadCurated();
  const teamIds = new Set(teams.map((team) => team.id));
  const errors = [...validateTeams(teams), ...validateStars(stars, teamIds)];
  if (errors.length > 0) {
    console.error(errors.map((error) => `- ${error}`).join("\n"));
    process.exitCode = 1;
    return;
  }
  const verifyStars = stars.filter((star) => star.status === "verify");
  const verifyTeams = teams.filter((team) => team.status === "verify");
  console.log(`OK: ${stars.length} stars, ${teams.length} teams`);
  console.log(`Verify: ${verifyStars.length} stars, ${verifyTeams.length} teams`);
  console.log(`Tier 5: ${stars.filter((star) => star.tier === 5).length}`);
  console.log(`Tier 4: ${stars.filter((star) => star.tier === 4).length}`);
  console.log(`Tier 3: ${stars.filter((star) => star.tier === 3).length}`);
}

async function teamsCommand(): Promise<void> {
  const { stars, teams } = await loadCurated();
  const starsByTeam = new Map<string, Star[]>();
  for (const star of stars) {
    starsByTeam.set(star.teamId, [...(starsByTeam.get(star.teamId) ?? []), star]);
  }
  for (const team of teams.sort((a, b) => a.name.localeCompare(b.name))) {
    const teamStars = starsByTeam.get(team.id) ?? [];
    console.log(`${team.name} (${team.competition})`);
    console.log(`  ${teamStars.map((star) => `${star.name} T${star.tier}`).join(", ") || "No tracked stars"}`);
  }
}

async function fixturesCommand(dateInput: string): Promise<void> {
  const fixtures = await fetchFixtures(dateInput);
  const date = localDate(dateInput);
  if (fixtures.length === 0) {
    console.log(`No tracked fixtures found for ${date}`);
    return;
  }
  for (const fixture of fixtures) {
    console.log(
      `${fixture.kickoffUtc} | ${fixture.competition} | ${fixture.homeTeam} vs ${fixture.awayTeam} | tracked: ${fixture.trackedTeamIds.join(", ")} | watch: ${fixture.broadcasts.join(", ") || "n/a"}`,
    );
  }
}

async function rangeCommand(dateInput: string, days: number): Promise<void> {
  const startDate = localDate(dateInput);
  const endDate = addDays(startDate, Math.max(0, days - 1));
  const fixtures = await fetchFixturesRange(startDate, endDate);
  if (fixtures.length === 0) {
    console.log(`No tracked fixtures found for ${startDate} to ${endDate}`);
    return;
  }
  for (const fixture of fixtures) {
    console.log(
      `${fixture.kickoffUtc} | ${fixture.competition} | ${fixture.homeTeam} vs ${fixture.awayTeam} | tracked: ${fixture.trackedTeamIds.join(", ")} | watch: ${fixture.broadcasts.join(", ") || "n/a"}`,
    );
  }
}

function excitementFromScore(score: number): 1 | 2 | 3 | 4 | 5 {
  if (score >= 85) return 5;
  if (score >= 70) return 4;
  if (score >= 55) return 3;
  if (score >= 40) return 2;
  return 1;
}

async function buildDay(dateInput: string): Promise<void> {
  const date = localDate(dateInput);
  const { stars, teams } = await loadCurated();
  const horizonEnd = addDays(date, 179);
  const fixtures = await fetchFixturesRange(date, horizonEnd);
  const allMatches = fixtures.map((fixture) => {
    const fixtureStars = starsForFixture(fixture, stars);
    const score = scoreFixture(fixture, fixtureStars);
    return {
      id: fixture.id,
      kickoffUtc: fixture.kickoffUtc,
      competition: fixture.competition,
      homeTeam: fixture.homeTeam,
      awayTeam: fixture.awayTeam,
      starNames: fixtureStars.map((star) => star.name),
      whyWatch: whyWatch(fixture, fixtureStars),
      watchUs: watchOptions(fixture, teams),
      score,
      excitement: excitementFromScore(score),
    };
  });
  const byScore = (a: GeneratedMatch, b: GeneratedMatch) =>
    b.score - a.score || new Date(a.kickoffUtc).getTime() - new Date(b.kickoffUtc).getTime();
  const before = (match: GeneratedMatch, days: number) => match.kickoffUtc.slice(0, 10) <= addDays(date, days - 1);
  const sections: MatchSection[] = [
    {
      id: "today",
      label: "Today",
      description: "Tracked matches on today’s slate.",
      matches: allMatches.filter((match) => match.kickoffUtc.slice(0, 10) === date).sort(byScore),
    },
    {
      id: "week",
      label: "This Week",
      description: "Best tracked matches over the next seven days.",
      matches: allMatches.filter((match) => before(match, 7)).sort(byScore),
    },
    {
      id: "month",
      label: "This Month",
      description: "Tracked matches over the next 30 days.",
      matches: allMatches.filter((match) => before(match, 30)).sort(byScore),
    },
    {
      id: "horizon",
      label: "Next 6 Months",
      description: "Top 10 highest-scoring tracked matches currently on public schedules.",
      matches: allMatches.sort(byScore).slice(0, 10),
    },
  ];
  const payload: DailyMatches = {
    generatedAt: new Date().toISOString(),
    date,
    timezone: "America/Los_Angeles",
    source: "fixture-api",
    matches: sections[0].matches,
    sections,
  };
  await writeFile(LATEST_PATH, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(
    `Wrote ${path.relative(ROOT, LATEST_PATH)} with ${sections.map((section) => `${section.id}:${section.matches.length}`).join(" ")}`,
  );
}

function help(): void {
  console.log(`BetweenTheCups CLI

Commands:
  validate                 Validate curated stars and teams
  teams                    Print tracked teams and stars
  fixtures --date today    Fetch public fixtures and print tracked matches
  range --date today       Fetch tracked fixtures for --days 180
  build-day --date today   Fetch fixtures and write data/generated/latest.json
`);
}

const { command, date, days } = parseArgs();
try {
  if (command === "validate") await validate();
  else if (command === "teams") await teamsCommand();
  else if (command === "fixtures") await fixturesCommand(date);
  else if (command === "range") await rangeCommand(date, days);
  else if (command === "build-day") await buildDay(date);
  else help();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
