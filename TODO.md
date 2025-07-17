# TODO.md

This document outlines the development tasks for creating the Genesys-OpenAI middleware. Tasks are organized by feature epics.

## Epic: Project Setup & Foundation

- [ ] Initialize a new Node.js project with TypeScript and Express.js
- [ ] Set up ESLint, Prettier, and Husky for code quality and consistency
- [ ] Configure a testing framework (e.g., Jest) with initial test setup
- [ ] Create a Dockerfile for building a production-ready container image
- [ ] Implement a configuration loader that supports environment variables and JSON files
- [ ] Implement a structured logger (e.g., Winston or Pino) for JSON-formatted logs

## Epic: Genesys Bot Connector API Implementation

- [ ] Implement `GET /botconnector/bots` endpoint to return a static, configurable list of bot profiles
- [ ] Implement `GET /botconnector/bots/{botId}` endpoint to return details for a single bot
- [ ] Create the skeleton for the `POST /botconnector/messages` endpoint
- [ ] Add a `/health` endpoint for health checks

## Epic: Security

- [ ] Implement a middleware function to validate the Connection Secret from Genesys headers on all incoming requests. Reject with 403 if invalid
- [ ] Implement logic within the `/messages` handler to securely extract the `OPENAI_API_KEY` from request headers. Ensure the key is never logged

## Epic: Message Processing (Genesys → OpenAI)

- [ ] **Core Transformation**: In the `/messages` handler, map the basic `inputMessage.text` from Genesys to the `input` field of the OpenAI request
- [ ] **Session Variable Mapping**: Implement logic to parse the `parameters` object from the Genesys request. Use `openai_model`, `openai_temperature`, etc., to override default OpenAI request parameters
- [ ] **Metadata Mapping**: Extract `genesysConversationId` and map it to the `metadata` field in the OpenAI request
- [ ] **Attachment Handling**:
  - [ ] Detect if `inputMessage.content` contains an attachment
  - [ ] Assuming the attachment is a PDF with a public URL, transform the OpenAI `input` field into the required array structure containing `input_file` and `input_text` objects
- [ ] **Tool Integration**:
  - [ ] Implement logic to load the MCP server configuration from the path specified by `MCP_SERVERS_CONFIG_PATH`
  - [ ] Add the loaded tool configurations to the `tools` array of the OpenAI request

## Epic: Session & Context Management

- [ ] Implement a session store abstraction that can switch between an in-memory map (for development) and Redis (for production) based on configuration
- [ ] In the `/messages` handler, before calling OpenAI, look up the `botSessionId` in the session store to retrieve the `previous_response_id`
- [ ] After receiving a successful response from OpenAI, update the session store with the new `response.id` for the corresponding `botSessionId`
- [ ] Set a TTL on the session store entry using the `botSessionTimeout` value from the Genesys request

## Epic: Message Processing (OpenAI → Genesys)

- [ ] **Response Transformation**: Map the `output_text` from the OpenAI response to the `replyMessages` array in the Genesys response format
- [ ] **State Management**: Implement the logic to set `botState`. Default to `MoreData` for successful responses to allow continued conversation. Set to `Failed` on any error
- [ ] **Error Handling**:
  - [ ] Create a robust error handling function for OpenAI API calls
  - [ ] Map OpenAI HTTP status codes and error bodies to the Genesys `ErrorInfo` object and the appropriate 4xx/5xx response code for Genesys

## Epic: Deployment & Testing

- [ ] Write unit tests for all transformation logic (Genesys-to-OpenAI and OpenAI-to-Genesys)
- [ ] Write integration tests for the `/messages` endpoint, mocking calls to the OpenAI API
- [ ] Create a CI/CD pipeline script (e.g., for GitHub Actions) to build, test, and push the Docker image to a registry
- [ ] Write comprehensive deployment instructions in the README.md, including required environment variables

---

## Progress Tracking

**Total Tasks**: 25  
**Completed**: 0  
**In Progress**: 0  
**Remaining**: 25

---

## Epic Priority Order

1. **Project Setup & Foundation** - Essential base infrastructure
2. **Security** - Critical for production deployment
3. **Genesys Bot Connector API Implementation** - Core API structure
4. **Message Processing (Genesys → OpenAI)** - Core transformation logic
5. **Session & Context Management** - Stateful conversation handling
6. **Message Processing (OpenAI → Genesys)** - Response transformation
7. **Deployment & Testing** - Production readiness

---

## Notes

- Tasks within each epic can often be worked on in parallel
- Security tasks should be prioritized and implemented early
- Testing should be written alongside feature implementation, not just at the end
- Consider creating feature branches for each epic to enable parallel development
