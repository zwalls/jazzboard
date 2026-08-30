# Netflix reference-architecture source packet

Accessed: 2026-08-30

This packet is the public evidence supplied to the held-out Netflix authoring trial. It is intentionally not a precomputed node list or layout. Netflix does not publish one canonical current diagram of its complete production system; the trial must label its result as a synthesis and distinguish directly supported facts from reasonable system-context inference.

## Primary sources

1. [Netflix Open Connect](https://openconnect.netflix.com/) and its [briefing paper](https://openconnect.netflix.com/Open-Connect-Briefing-Paper.pdf)
   - Open Connect combines Netflix's backbone infrastructure with Open Connect Appliances placed at ISP or internet-exchange locations.
   - The CDN serves the video/audio objects used for playback; this is a distinct path from cloud control and API requests.

2. [Zuul — Netflix OSS](https://github.com/Netflix/zuul)
   - Zuul is an L7 application gateway supporting dynamic routing, monitoring, resiliency, and security.
   - The repository links Netflix's Zuul 2 engineering articles. The trial may depict Zuul as a supported gateway concept, but must not claim one OSS release describes every current Netflix edge deployment.

3. [EVCache — Netflix OSS](https://github.com/Netflix/EVCache)
   - EVCache is an ephemeral, volatile, distributed in-memory cache used with AWS EC2 infrastructure for frequently accessed data.

4. [Titus overview](https://netflix.github.io/titus/overview/) and [Titus control plane](https://github.com/Netflix/titus-control-plane)
   - Titus is Netflix's container-management platform and has powered streaming, recommendation, and content workloads.
   - The public architecture includes a gateway, scheduler/control plane, agents, and container workloads integrated with AWS.

5. [The Making of VES: the Cosmos Microservice for Netflix Video Encoding](https://netflixtechblog.com/the-making-of-ves-the-cosmos-microservice-for-netflix-video-encoding-946b9b3cd300)
   - Cosmos is Netflix's media-compute platform; VES is a video-encoding service built on it.
   - This supports a separate content-ingest and media-processing plane that produces playback assets, not a claim that the article documents the complete consumer request path.

6. [From Silos to Service Topology: Why Netflix Built a Real-Time Service Map](https://netflixtechblog.com/from-silos-to-service-topology-why-netflix-built-a-real-time-service-map-0165ba13a7bc)
   - Netflix describes thousands of microservices and a play request that can involve authentication, recommendations, encoding selection, and playback optimization.
   - Its living service map combines separate graphs derived from eBPF network flows, instrumented IPC metrics, and sampled end-to-end traces.
   - The published high-level ingestion path uses multi-region Kafka, staged distributed processing, graph storage, and a gRPC query API.

7. [Learning a Personalized Homepage](https://netflixtechblog.com/learning-a-personalized-homepage-aa8ec670359a)
   - Netflix's member experience uses personalized page generation to select and order relevant titles and rows.

8. [The Evolution of Cassandra Data Movement at Netflix](https://netflixtechblog.com/the-evolution-of-cassandra-data-movement-at-netflix-6e13329c80a1)
   - Netflix states that Cassandra supports mission-critical domains including member, billing, recommendations, and subscriptions.
   - The 2026 data-movement design reads backup metadata and data from S3 into a layered Spark/DataFrame processing stack. It is supporting data-platform evidence, not a required synchronous playback dependency.

## Synthesis constraints

- Show two visibly distinct member flows: API/control requests through the cloud gateway and large media objects from Open Connect.
- Separate consumer-serving, data/event, observability, runtime, and content-processing zones.
- Treat exact service names and individual dependency edges beyond these sources as a clearly labeled reference-model inference.
- Do not use the archived Netflix Conductor OSS repository as proof of a current production dependency.
- Do not imply that an Open Connect Appliance calls member-profile, catalog, or recommendation services to deliver bytes.
- Preserve directionality: prepared media flows toward Open Connect distribution; playback telemetry and service signals flow toward the data/observability planes.

