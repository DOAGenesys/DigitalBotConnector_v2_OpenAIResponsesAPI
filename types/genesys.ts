export interface GenesysIncomingMessagesRequest {
  botId: string;
  botVersion: string;
  botSessionId?: string;
  messageId: string;
  inputMessage: {
    type: 'Text' | 'Structured';
    text?: string;
    content?: { contentType: string; [key: string]: any }[];
  };
  languageCode: string;
  botSessionTimeout: number;
  genesysConversationId: string;
  parameters?: { [key: string]: string };
}

export interface GenesysIncomingMessagesResponse {
  botState: GenesysBotState;
  replyMessages: GenesysReplyMessage[];
  intent?: string;
  confidence?: number;
  entities?: any[];
  parameters?: { [key: string]: string };
  errorInfo?: GenesysErrorInfo;
}

export type GenesysBotState = 'Complete' | 'Failed' | 'MoreData';

export interface GenesysReplyMessage {
  type: 'Text' | 'Structured';
  text?: string;
  content?: any[];
}

export interface GenesysErrorInfo {
  errorCode: string;
  errorMessage: string;
}
