export type OneBotMessageSegment =
  | { type: "text"; data: { text: string } }
  | { type: "image"; data: { file: string; url?: string; path?: string; name?: string; file_size?: number | string } }
  | { type: "record"; data: { file: string; url?: string; path?: string; text?: string; file_size?: number | string } }
  | { type: "video"; data: { file: string; url?: string; path?: string; file_size?: number | string; name?: string } }
  | {
      type: "file";
      data: {
        file?: string;
        name?: string;
        file_name?: string;
        url?: string;
        file_id?: string;
        file_uuid?: string;
        fileUuid?: string;
        busid?: number | string;
        file_size?: number | string;
      };
    }
  | { type: "json"; data?: Record<string, unknown> }
  | { type: "forward"; data: { id: string } }
  | { type: "at"; data: { qq: string } }
  | { type: "reply"; data: { id: string } };

export type OneBotMessage = OneBotMessageSegment[];

export type OneBotEvent = {
  time: number;
  self_id: number;
  post_type: string;
  meta_event_type?: string;
  message_type?: "private" | "group" | "guild";
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  message?: OneBotMessage | string;
  raw_message?: string;
  sender?: {
    user_id: number;
    nickname: string;
    card?: string;
    role?: string;
  };
};
