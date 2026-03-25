import { Type } from "@sinclair/typebox";
import { google } from "googleapis";
import type { ToolEntry } from "./tool-registry";
import type { CredentialStore } from "./credential-store";
import { getGoogleAuth } from "./google-auth";
import { errorMessage } from "./errors";

export interface GoogleCalendarToolOptions {
  credentialStore?: CredentialStore;
  maxResults?: number;
}

const DEFAULT_MAX_RESULTS = 25;

function textResult(text: string, details?: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text }], details };
}

export function createGoogleCalendarToolEntries(opts?: GoogleCalendarToolOptions): ToolEntry[] {
  const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;

  const calendarList: ToolEntry = {
    name: "calendar_list",
    source: "local",
    description: "List upcoming events from Google Calendar. Can filter by time range and calendar ID.",
    parameters: Type.Object({
      timeMin: Type.Optional(Type.String({ description: "Start of time range (ISO 8601, e.g. '2024-01-15T00:00:00Z'). Default: now." })),
      timeMax: Type.Optional(Type.String({ description: "End of time range (ISO 8601). Default: 7 days from now." })),
      calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: 'primary')" })),
      maxResults: Type.Optional(Type.Number({ description: `Max events to return (default: ${DEFAULT_MAX_RESULTS})` })),
    }),
    defaultPermission: "allow",
    available: true,
    execute: async (_toolCallId, params) => {
      const calendarId = (params.calendarId as string) ?? "primary";
      const now = new Date();
      const timeMin = (params.timeMin as string) ?? now.toISOString();
      const timeMax = (params.timeMax as string) ?? new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
      const limit = Math.min((params.maxResults as number | undefined) ?? maxResults, maxResults);

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const calendar = google.calendar({ version: "v3", auth });

        const res = await calendar.events.list({
          calendarId,
          timeMin,
          timeMax,
          maxResults: limit,
          singleEvents: true,
          orderBy: "startTime",
        });

        const events = (res.data.items ?? []).map(e => ({
          id: e.id,
          summary: e.summary,
          description: e.description,
          location: e.location,
          start: e.start?.dateTime ?? e.start?.date,
          end: e.end?.dateTime ?? e.end?.date,
          attendees: e.attendees?.map(a => ({ email: a.email, responseStatus: a.responseStatus })),
          htmlLink: e.htmlLink,
          status: e.status,
        }));

        const resultData = { calendarId, timeMin, timeMax, eventCount: events.length, events };
        return textResult(JSON.stringify(resultData, null, 2), resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const calendarCreate: ToolEntry = {
    name: "calendar_create",
    source: "local",
    description: "Create a new event in Google Calendar.",
    parameters: Type.Object({
      summary: Type.String({ description: "Event title" }),
      start: Type.String({ description: "Start time (ISO 8601, e.g. '2024-01-15T10:00:00-03:00')" }),
      end: Type.String({ description: "End time (ISO 8601)" }),
      description: Type.Optional(Type.String({ description: "Event description" })),
      location: Type.Optional(Type.String({ description: "Event location" })),
      attendees: Type.Optional(Type.Array(Type.String(), { description: "Attendee email addresses" })),
      calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: 'primary')" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const summary = params.summary as string;
      const start = params.start as string;
      const end = params.end as string;
      const description = params.description as string | undefined;
      const location = params.location as string | undefined;
      const attendees = params.attendees as string[] | undefined;
      const calendarId = (params.calendarId as string) ?? "primary";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const calendar = google.calendar({ version: "v3", auth });

        const res = await calendar.events.insert({
          calendarId,
          requestBody: {
            summary,
            description,
            location,
            start: { dateTime: start },
            end: { dateTime: end },
            attendees: attendees?.map(email => ({ email })),
          },
        });

        const resultData = {
          eventId: res.data.id,
          summary,
          start,
          end,
          htmlLink: res.data.htmlLink,
        };
        return textResult(`Event created: "${summary}" on ${start}`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const calendarUpdate: ToolEntry = {
    name: "calendar_update",
    source: "local",
    description: "Update an existing Google Calendar event. Only provided fields are changed.",
    parameters: Type.Object({
      eventId: Type.String({ description: "The event ID to update" }),
      summary: Type.Optional(Type.String({ description: "New event title" })),
      start: Type.Optional(Type.String({ description: "New start time (ISO 8601)" })),
      end: Type.Optional(Type.String({ description: "New end time (ISO 8601)" })),
      description: Type.Optional(Type.String({ description: "New description" })),
      location: Type.Optional(Type.String({ description: "New location" })),
      calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: 'primary')" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const eventId = params.eventId as string;
      const calendarId = (params.calendarId as string) ?? "primary";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const calendar = google.calendar({ version: "v3", auth });

        // Get current event
        const current = await calendar.events.get({ calendarId, eventId });
        const patch: any = {};

        if (params.summary !== undefined) patch.summary = params.summary;
        if (params.description !== undefined) patch.description = params.description;
        if (params.location !== undefined) patch.location = params.location;
        if (params.start !== undefined) patch.start = { dateTime: params.start as string };
        if (params.end !== undefined) patch.end = { dateTime: params.end as string };

        const res = await calendar.events.patch({
          calendarId,
          eventId,
          requestBody: patch,
        });

        const resultData = {
          eventId,
          summary: res.data.summary,
          start: res.data.start?.dateTime,
          end: res.data.end?.dateTime,
        };
        return textResult(`Event updated: "${res.data.summary}"`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  const calendarDelete: ToolEntry = {
    name: "calendar_delete",
    source: "local",
    description: "Delete an event from Google Calendar.",
    parameters: Type.Object({
      eventId: Type.String({ description: "The event ID to delete" }),
      calendarId: Type.Optional(Type.String({ description: "Calendar ID (default: 'primary')" })),
    }),
    defaultPermission: "hitl",
    available: true,
    execute: async (_toolCallId, params) => {
      const eventId = params.eventId as string;
      const calendarId = (params.calendarId as string) ?? "primary";

      try {
        const auth = await getGoogleAuth({ credentialStore: opts?.credentialStore });
        const calendar = google.calendar({ version: "v3", auth });

        await calendar.events.delete({ calendarId, eventId });

        const resultData = { eventId, calendarId };
        return textResult(`Event deleted: ${eventId}`, resultData);
      } catch (err) {
        return textResult(`Error: ${errorMessage(err)}`);
      }
    },
  };

  return [calendarList, calendarCreate, calendarUpdate, calendarDelete];
}
