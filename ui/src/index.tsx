import * as React from "react";
import { RolloutWidget } from "argo-rollouts/ui/src/app/components/rollout/rollout";
import { ObjectMeta, TypeMeta } from "argo-rollouts/ui/src/models/kubernetes";
import { RolloutRolloutInfo, RolloutReplicaSetInfo, RolloutAnalysisRunInfo } from "argo-rollouts/ui/src/models/rollout/generated";

export type State = TypeMeta & { metadata: ObjectMeta } & {
  status: any;
  spec: any;
};

const parseInfoFromResourceNode = (
  tree: any,
  resource: State
): RolloutRolloutInfo => {
  const ro: RolloutRolloutInfo = {};
  const { spec, status, metadata } = resource;
  ro.objectMeta = metadata as any;
  ro.analysisRuns = parseAnalysisRuns(tree, resource);
  ro.replicaSets = parseReplicaSets(tree, resource);

  if (spec.strategy.canary) {
    ro.strategy = "Canary";
    const steps = spec.strategy?.canary?.steps || [];
    ro.steps = steps;

    if (steps && status.currentStepIndex !== null && steps.length > 0) {
      ro.step = `${status.currentStepIndex}/${steps.length}`;
    }

    const { currentStep, currentStepIndex } = parseCurrentCanaryStep(resource);
    ro.setWeight = parseCurrentSetWeight(resource, currentStepIndex);

    ro.actualWeight = "0";

    if (!currentStep) {
      ro.actualWeight = "100";
    } else if (status.availableReplicas > 0) {
      if (!spec.strategy.canary.trafficRouting) {
        for (const rs of ro.replicaSets) {
          if (rs.canary) {
            ro.actualWeight = `${rs.available / status.availableReplicas}`;
          }
        }
      } else {
        ro.actualWeight = ro.setWeight;
      }
    }
  } else {
    ro.strategy = "BlueGreen";
  }

  ro.containers = [];
  if (spec.template) {
    console.log("we have template")
    for (const c of spec.template?.spec?.containers) {
      ro.containers.push({ name: c.name, image: c.image });
    }
  } else if (spec.workloadRef) {
    console.log("we have workloadref")
    const deployment = parseWorkloadRef(tree, resource);
    console.log(deployment)
    if (deployment && deployment.spec) {
      for (const c of deployment.spec.template?.spec?.containers) {
        ro.containers.push({ name: c.name, image: c.image });
      }
    }
  }

  ro.current = status.replicas;
  ro.updated = status.updatedReplicas;
  ro.available = status.availableReplicas;
  return ro;
};

const parseCurrentCanaryStep = (
  resource: State
): { currentStep: any; currentStepIndex: number } => {
  const { status, spec } = resource;
  const canary = spec.strategy?.canary;
  if (!canary || !canary.steps || canary.steps.length === 0) {
    return { currentStep: null, currentStepIndex: -1 };
  }
  let currentStepIndex = 0;
  if (status.currentStepIndex) {
    currentStepIndex = status.currentStepIndex;
  }
  if (canary?.steps?.length <= currentStepIndex) {
    return { currentStep: null, currentStepIndex };
  }
  const currentStep = canary?.steps[currentStepIndex];
  return { currentStep, currentStepIndex };
};

const parseCurrentSetWeight = (resource: State, currentStepIndex: number): string => {
  const { status, spec } = resource;
  if (status.abort) {
    return "0";
  }

  for (let i = currentStepIndex; i >= 0; i--) {
    const step = spec.strategy?.canary?.steps[i];
    if (step?.setWeight) {
      return step.setWeight;
    }
  }
  return "0";
};

const parseRevision = (node: any) => {
  for (const item of node.info || []) {
    if (item.name === "Revision") {
      const parts = item.value.split(":") || [];
      return parts.length == 2 ? parts[1] : "0";
    }
  }
};

const parsePodStatus = (pod: any) => {
  for (const item of pod.info || []) {
    if (item.name === "Status Reason") {
      return item.value;
    }
  }
};

const parseAnalysisRuns = (tree: any, rollout: any): RolloutAnalysisRunInfo[] => tree.nodes
    .filter(node => (node.kind === 'AnalysisRun') && (node.parentRefs.some(ref => ref.name === rollout.metadata.name)))
    .map(node => ({
      objectMeta: {
        creationTimestamp: {
          seconds: node.createdAt,
        },
        name: node.name,
        namespace: node.namespace,
        resourceVersion: node.version,
        uid: node.uid,
      },
      revision: parseRevision(node),
      status: parseAnalysisRunStatus(node.health.status),
    }) as RolloutAnalysisRunInfo);

const parseAnalysisRunStatus = (status: string): string => {
  switch(status) {
    case 'Healthy':
      return 'Successful';
    case 'Progressing':
      return 'Running';
    case 'Degraded':
      return 'Failure';
    default:
      return 'Error';
  }
}

const parseReplicaSets = (tree: any, rollout: any): RolloutReplicaSetInfo[] => {
  const allReplicaSets = [];
  const allPods = [];
  for (const node of tree.nodes) {
    if (node.kind === "ReplicaSet") {
      allReplicaSets.push(node);
    } else if (node.kind === "Pod") {
      allPods.push(node);
    }
  }
  const ownedReplicaSets: { [key: string]: any } = {};

  for (const rs of allReplicaSets) {
    for (const parentRef of rs.parentRefs) {
      if (
        parentRef?.kind === "Rollout" &&
        parentRef?.name === rollout?.metadata?.name
      ) {
        let ownedRS = {
          pods: [],
          objectMeta: {
            name: rs.name,
            uid: rs.uid,
          },
          status: rs.health.status,
          revision: parseRevision(rs),
        }
        ownedReplicaSets[rs?.name] = ownedRS;
      }
    }
  }

  const podMap: { [key: string]: any[] } = {};

  for (const pod of allPods) {
    let ownedPod = {
      objectMeta: {
        name: pod.name,
        uid: pod.uid,
      },
      status: parsePodStatus(pod),
    }
    for (const parentRef of pod.parentRefs) {
      const pods = podMap[parentRef?.name] || [];
      if (parentRef.kind === "ReplicaSet" && pods?.length > -1) {
        pods.push(ownedPod);
        podMap[parentRef?.name] = [...pods];
      }
    }
  }

  return (Object.values(ownedReplicaSets) || []).map((rs) => {
    rs.pods = podMap[rs.name] || [];
    return rs;
  });
};

const parseWorkloadRef = (tree: any, rollout: any): State | undefined =>
  (tree.nodes.find(
    (node) =>
      (node.kind === rollout.spec.workloadRef.kind) && (node.name === rollout.spec.workloadRef.name)
  ) as State);

interface ApplicationResourceTree {}
export const Extension = (props: {
  tree: ApplicationResourceTree;
  resource: State;
}) => {
  const ro = parseInfoFromResourceNode(props.tree, props.resource);
  return <RolloutWidget rollout={ro} />;
};

export const component = Extension;
