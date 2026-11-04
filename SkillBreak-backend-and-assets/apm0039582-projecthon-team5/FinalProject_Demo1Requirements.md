# Projecthon — Demo 1 Requirements: Local Setup and Backend–Database Flow

## Objective

Verify that the team can run its backend locally, configure its database connection through environment variables, use an ORM, and complete a basic API-to-database flow.

This checkpoint demonstrates the **technical foundation**. It is not a requirement to complete the first committed product feature or build a frontend.

## Demo KPIs

The team must meet each required target and show the listed evidence during the demo. Together, these KPIs demonstrate that the project can be set up, connected to a real database, and safely extended in the next development stage.

| Area | Measurable KPI / target | Evidence to show | Value |
|---|---|---|---|
| Local setup | **100% of required setup steps** are documented in the repository README, including prerequisites, configuration, start/stop commands, and relevant checks. No undocumented manual steps are needed to start the project. | Follow the README to start the backend and required local dependencies, or have a teammate follow it. Show successful startup using health checks, logs, or another clear indicator. | Makes the project reproducible and reduces setup friction for every team member. |
| Environment configuration | **100% of required database configuration variables** are read from the local `.env` file. A matching `.env.example` lists every required variable with placeholder values. The real `.env` is excluded from version control; **zero real secrets** are committed. | Show the variable names in `.env.example`, where the application/ORM loads them, and the relevant ignore rule. Do not display secret values. | Keeps local configuration consistent while preventing credentials from being exposed. |
| ORM and data model | At least **1 ORM-managed entity/model** is defined and mapped to a database table. Application database reads and writes in the demonstrated flow use the ORM, not raw in-memory data or a mocked repository. | Identify the ORM, show the entity/model and ORM configuration, and trace the API operation to the ORM call. | Establishes the persistence pattern the team will use when implementing product features. |
| Schema initialization | The schema can be created or updated on a clean local database using the project's documented ORM-supported migration or schema tooling. The process is repeatable. | Run or show the documented schema command and its successful result. Explain how demo/seed data is reset if it is used. | Allows developers to create a predictable database without relying on undocumented manual changes. |
| API-to-database flow | At least **1 real API flow** completes successfully: the backend receives a request through Swagger UI, processes it through the ORM, interacts with the running database, and returns the expected response. | Use **Swagger UI only** to send the request and show the response. | Proves that the backend and database are connected through the actual application path and that the API is accessible through its interactive documentation. |
| Persistence | **1 record or data change** created/updated through the API can be retrieved by a subsequent read request. The data remains available after restarting the backend. | Create or update data, read it back, restart the backend, and read it again. | Confirms that data is persisted in the database rather than held only in application memory. |
| Next-stage readiness | The team identifies **1 first committed feature** planned for Demo 2 and can state its intended outcome. The project design is updated to reflect all changes needed to support that feature. | Briefly name the feature and describe what a user should be able to accomplish when it is complete. Show the updated design and explain how it accounts for the required changes. | Creates a clear handoff from the technical foundation to feature delivery and aligns the design with the upcoming implementation. |

## Demo Flow

Use one small API operation that demonstrates the KPIs above. It does not need to be the first committed major feature or represent the complete product experience.

1. Start the backend and database locally using the documented setup.
2. Show that the backend and ORM load the database settings from the local `.env` file.
3. Show the ORM entity/model and the documented schema initialization method.
4. Use Swagger UI to create or update a record through the backend.
5. Identify the first committed feature planned for Demo 2.

The demonstrated flow must use the actual backend and running database. Mocked responses and in-memory substitutes do not meet the API-flow or persistence targets. No frontend is required for Demo 1.


