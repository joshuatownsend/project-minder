import { promises as fs } from "fs";
import path from "path";
import yaml from "js-yaml";
import { PortMapping } from "../types";

interface DockerResult {
  services: string[];
  ports: PortMapping[];
}

export async function scanDockerCompose(
  projectPath: string
): Promise<DockerResult> {
  const result: DockerResult = { services: [], ports: [] };
  const files = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"];

  for (const file of files) {
    try {
      const content = await fs.readFile(
        path.join(projectPath, file),
        "utf-8"
      );
      const doc = yaml.load(content) as Record<string, unknown>;
      if (!doc || typeof doc !== "object") continue;

      const services = (doc.services || {}) as Record<string, unknown>;

      for (const [serviceName, serviceConfig] of Object.entries(services)) {
        result.services.push(serviceName);

        const config = serviceConfig as Record<string, unknown>;
        const ports = config.ports as string[] | undefined;
        if (Array.isArray(ports)) {
          for (const portMapping of ports) {
            const str = String(portMapping);
            const match = str.match(/(\d+):(\d+)/);
            if (match) {
              result.ports.push({
                service: serviceName,
                host: parseInt(match[1], 10),
                container: parseInt(match[2], 10),
              });
            }
          }
        }
      }

      break; // Use first found file
    } catch {
      // File doesn't exist or invalid YAML
    }
  }

  return result;
}
