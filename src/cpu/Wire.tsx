import { assignImm, getOrAddToMap, isNil } from "../utils/data";
import { segmentNearestPoint, segmentNearestT, Vec3 } from "../utils/vector";
import { IWire, ISegment, IWireGraph, IWireGraphNode, ICpuLayoutBase, IElRef, RefType } from "./CpuModel";

export function moveWiresWithComp(layout: ICpuLayoutBase, compIdx: number, delta: Vec3): IWireGraph[] {
    let comp = layout.comps[compIdx];

    let newWires: IWireGraph[] = [];
    for (let wire of layout.wires) {
        for (let node of wire.nodes) {
            if (node.ref?.type === RefType.CompNode && node.ref.id === comp.id) {
                node.pos = snapToGrid(node.pos.add(delta));
            }
        }
        newWires.push(wire);
    }

    return newWires;
}

export function dragSegment(wire: IWireGraph, node0Idx: number, node1Idx: number, delta: Vec3) {

    // let seg = wire.segments[segId];
    let node0 = wire.nodes[node0Idx];
    let node1 = wire.nodes[node1Idx];

    // let [node0, node1] = findNodesForSegment(wireGraph, seg);
    // hmm, need to match the segId to the node id pair

    // we're gonna move both of these nodes
    // but also iterate through all nodes colinear with this segment, and move them by the same amount
    // Since we're not dealing with angled lines, don't have to re-evaluate the intersection point
    let segDir = node1.pos.sub(node0.pos).normalize();

    let nodesToMove = new Set<number>();
    let nodeStack = [node0Idx, node1Idx];
    let seenIds = new Set<number>();

    let newNodes = [...wire.nodes];

    while (nodeStack.length > 0) {
        let nodeIdx0 = nodeStack.pop()!;
        let node0 = wire.nodes[nodeIdx0];
        if (seenIds.has(node0.id)) {
            continue;
        }
        seenIds.add(node0.id);
        nodesToMove.add(nodeIdx0);
        for (let nodeIdx1 of node0.edges) {
            let node1 = wire.nodes[nodeIdx1];
            let dir = node1.pos.sub(node0.pos).normalize();
            let dotProd = dir.dot(segDir);
            if (dotProd > 1 - EPSILON || dotProd < -1 + EPSILON) {
                nodeStack.push(nodeIdx1);
            }
        }
    }

    for (let nodeIdx of nodesToMove) {
        newNodes[nodeIdx] = assignImm(newNodes[nodeIdx], {
            pos: snapToGrid(newNodes[nodeIdx].pos.add(delta)),
         });
    }

    return assignImm(wire, { nodes: newNodes });
}

export function applyWires(layout: ICpuLayoutBase, wires: IWireGraph[], editIdx: number): ICpuLayoutBase {

    let [editedWires, newWires] = fixWires(layout, wires, editIdx);
    let nextWireId = layout.nextWireId;
    for (let wire of newWires) {
        wire.id = '' + nextWireId++;
    }


    let allWires = [...editedWires, ...newWires];

    checkWires(editedWires, 'applyWires (post-fixWires edited)');
    checkWires(newWires, 'applyWires (post-fixWires new)');

    return assignImm(layout, {
        nextWireId,
        wires: allWires,
    })
}

export function checkWires(wires: IWireGraph[], name: string) {
    for (let wire of wires) {
        if (wire.nodes.some(n => n.edges.some(e => isNil(e) || isNil(wire.nodes[e])))) {
            throw new Error(`CHECK [${name}]: Wire ${wire.id} has dangling edges`);
        }
    }
}

export function copyWireGraph(wire: IWireGraph): IWireGraph {
    let nodes = wire.nodes.map(n => ({ ...n, edges: n.edges.slice() }));
    return { ...wire, nodes };
}

function createNodePosMap(layout: ICpuLayoutBase) {
    let nodePosMap = new Map<string, { pos: Vec3, ref: IElRef }>();
    for (let comp of layout.comps) {
        for (let node of comp.nodes ?? []) {
            let nodePos = comp.pos.add(node.pos);
            let ref: IElRef = {
                type: RefType.CompNode,
                id: comp.id,
                compNodeId: node.id,
            };
            let posStr = `${nodePos.x},${nodePos.y}`;
            nodePosMap.set(posStr, { pos: nodePos, ref });
        }
    }

    return nodePosMap;
}

export function iterWireGraphSegments(graph: IWireGraph, cb: (node0: IWireGraphNode, node1: IWireGraphNode) => boolean | void) {
    for (let node0 of graph.nodes) {
        for (let nodeId of node0.edges) {
            let node1 = graph.nodes[nodeId];
            if (!node1) {
                throw new Error(`Couldn't find node ${nodeId}`);
            }
            if (node1.id > node0.id) {
                let res = cb(node0, node1);
                if (res === false) {
                    return;
                }
            }
        }
    }
}

/** Two main things to fix:
    1. wires that are touching each other get merged
    2. wires that have islands get split
*/
export function fixWires(layout: ICpuLayoutBase, wires: IWireGraph[], editIdx: number): [editedWires: IWireGraph[], newWires: IWireGraph[]] {
    wires = [...wires];
    let editWire = wires[editIdx];

    // find all wires that are touching the edit wire
    let wireIdxsToMerge = new Set<number>();

    for (let i = 0; i < wires.length; i++) {
        if (i === editIdx) {
            continue;
        }

        let wire = wires[i];

        let merged = false;
        // find any segments that are touching the edit wire
        iterWireGraphSegments(wire, (node0, node1) => {
            let seg1 = { p0: node0.pos, p1: node1.pos };

            iterWireGraphSegments(editWire, (editNode0, editNode1) => {
                let seg2 = { p0: editNode0.pos, p1: editNode1.pos };

                if (segsTouching(seg1, seg2)) {
                    merged = true;
                    wireIdxsToMerge.add(i);
                    return false;
                }
            });

            return !merged;
        });
    }

    if (wireIdxsToMerge.size > 0) {
        let newWire = graphToWire(editWire);

        for (let idx of wireIdxsToMerge) {
            let wire = graphToWire(wires[idx]);
            for (let seg of wire.segments) {
                newWire.segments.push(seg);
            }
        }

        wires[editIdx] = wireToGraph(newWire);

        let idxsBelowNewIdx = Array.from(wireIdxsToMerge).filter(i => i < editIdx).length;
        wires = wires.filter((_, i) => !wireIdxsToMerge.has(i));
        editIdx -= idxsBelowNewIdx;
    }

    wires[editIdx] = fixWire(wires[editIdx]);

    let editWireGraph = wires[editIdx];

    let nodePosMap = createNodePosMap(layout);
    for (let node of editWireGraph.nodes) {
        let posStr = `${node.pos.x},${node.pos.y}`;
        let nodePos = nodePosMap.get(posStr);
        if (nodePos) {
            node.ref = nodePos.ref;
        }
    }

    checkWires(wires, 'fixWires (pre-splitIntoIslands)');

    let islands = splitIntoIslands(editWireGraph);

    wires.splice(editIdx, 1, islands[0]);
    wires = wires.filter(a => !!a);
    let newWires = islands.slice(1);

    if (newWires.length > 0) {
        console.log('islands:', islands);
    }

    checkWires(wires, 'fixWires (post-splitIntoIslands)');
    checkWires(newWires, 'fixWires (post-splitIntoIslands new)');

    return [wires, newWires];
}

export function splitIntoIslands(wire: IWireGraph): IWireGraph[] {

    let islands: IWireGraphNode[][] = [];
    let seenIds = new Set<number>();

    for (let i = 0; i < wire.nodes.length; i++) {
        let startNode = wire.nodes[i];

        if (!seenIds.has(startNode.id)) {
            let stack = [startNode];
            let island: IWireGraphNode[] = [];

            while (stack.length > 0) {
                let node = stack.pop()!;

                if (!seenIds.has(node.id)) {
                    island.push(node);
                    seenIds.add(node.id);

                    for (let edgeId of node.edges) {
                        stack.push(wire.nodes[edgeId]);
                    }
                }
            }
            if (island.length > 1) {
                islands.push(island);
            }
        }
    }

    if (islands.length === 1) {
        return [wire];
    }

    return islands.map(island => repackGraphIds(assignImm(wire, { nodes: island })));
}

export function repackGraphIds(wire: IWireGraph): IWireGraph {

    let idCntr = 0;
    let idMap = new Map<number, number>();
    let newNodes: IWireGraphNode[] = [];
    for (let node of wire.nodes) {
        let newId = idCntr++;
        idMap.set(node.id, newId);
        newNodes.push(assignImm(node, { id: newId }));
    }
    for (let node of newNodes) {
        node.edges = node.edges.map(id => idMap.get(id)!);
    }
    return assignImm(wire, { nodes: newNodes });
}

export function wireToGraph(wire: IWire): IWireGraph {
    let isects = new Map<string, IWireGraphNode>();

    function getNode(pos: Vec3, ref?: IElRef) {
        let key = `${pos.x.toFixed(5)},${pos.y.toFixed(5)}`;
        let node = getOrAddToMap(isects, key, () => ({ id: isects.size, pos, edges: [] }));
        node.ref = node.ref || ref;
        return node;
    }

    for (let seg0 of wire.segments) {
        let node0 = getNode(seg0.p0, seg0.comp0Ref);
        let node1 = getNode(seg0.p1, seg0.comp1Ref);

        let nodesOnLine: { t: number, node: IWireGraphNode }[] = [
            { t: 0, node: node0 },
            { t: 1, node: node1 },
        ];

        for (let seg1 of wire.segments) {
            if (seg0 === seg1) {
                continue;
            }

            for (let pt of [seg1.p0, seg1.p1]) {
                if (segAttachedToInner(seg0, pt)) {
                    nodesOnLine.push({
                        t: segmentNearestT(seg0.p0, seg0.p1, pt),
                        node: getNode(pt),
                    });
                }
            }
        }

        nodesOnLine.sort((a, b) => a.t - b.t);

        for (let i = 0; i < nodesOnLine.length - 1; i++) {
            let nodeA = nodesOnLine[i];
            let nodeB = nodesOnLine[i + 1];
            if (nodeA.node !== nodeB.node) {
                nodeA.node.edges.push(nodeB.node.id);
                nodeB.node.edges.push(nodeA.node.id);
            }
        }
    }

    return {
        id: wire.id,
        nodes: Array.from(isects.values()),
    };
}

function findNodesForSegment(wire: IWireGraph, { p0, p1 }: ISegment): [number, number] {
    for (let node0 of wire.nodes) {
        if (p0.dist(node0.pos) > EPSILON) {
            continue;
        }

        for (let edgeId of node0.edges) {
            let node1 = wire.nodes[edgeId];
            if (p1.dist(node1.pos) < EPSILON) {
                return [node0.id, node1.id];
            }
        }
    }

    throw new Error(`Couldn't find node and edge for ${p0} -> ${p1}`);
}

export function graphToWire(graph: IWireGraph): IWire {

    let segments: ISegment[] = [];

    for (let node0 of graph.nodes) {
        for (let nodeId of node0.edges) {
            let node1 = graph.nodes[nodeId];
            if (node1.id > node0.id) {
                segments.push({ p0: node0.pos, p1: node1.pos, comp0Ref: node0.ref, comp1Ref: node1.ref });
            }
        }
    }

    return {
        id: graph.id,
        segments,
    };
}

export const EPSILON = 0.001;

export function fixWire(wireGraph: IWireGraph) {

    let wire = graphToWire(wireGraph);
    let segs = wire.segments.map(a => ({ ...a }));

    let segIdsToRemove = new Set<number>();

    for (let seg0 of segs) {

        for (let seg1Idx = 0; seg1Idx < wire.segments.length; seg1Idx++) {
            let seg1 = segs[seg1Idx];

            if (seg0 === seg1) {
                continue;
            }

            if (segAttachedTo(seg0, seg1.p0)) {
                if (segAttachedTo(seg0, seg1.p1)) {
                    // seg1 is inside seg0 => remove seg1
                    segIdsToRemove.add(seg1Idx);
                } else if (segAttachedTo(seg1, seg0.p0)) {
                    // seg1 is to the left of seg0 => truncate seg1 to seg0.p0
                    seg1.p0 = seg0.p0;
                } else if (segAttachedTo(seg1, seg0.p1)) {
                    // seg1 is to the right of seg0 => truncate seg1 to seg0.p1
                    seg1.p0 = seg0.p1;
                }
            }
        }
    }

    let newSegs = segs
        .filter((_, i) => !segIdsToRemove.has(i))
        .filter(s => s.p0.distSq(s.p1) > EPSILON * EPSILON);
    wire = assignImm(wire, { segments: newSegs });

    return wireToGraph(wire);
}

export function filterImm<T>(arr: T[], pred: (t: T) => boolean) {
    let newArr = arr.filter(pred);
    return newArr.length === arr.length ? arr : newArr;
}

export function segAttachedTo(seg: ISegment, pt: Vec3) {
    let nearest = segmentNearestPoint(seg.p0, seg.p1, pt);
    return nearest.distSq(pt) < EPSILON * EPSILON;
}

export function segAttachedToInner(seg: ISegment, pt: Vec3) {
    if (!segAttachedTo(seg, pt)) {
        return false;
    }
    let t = segmentNearestT(seg.p0, seg.p1, pt);
    return t > EPSILON && t < 1.0 - EPSILON;
}

export function segsTouching(seg1: ISegment, seg2: ISegment) {
    return segAttachedTo(seg1, seg2.p0) || segAttachedTo(seg1, seg2.p1) || segAttachedTo(seg2, seg1.p0) || segAttachedTo(seg2, seg1.p1);
}


function snapToGrid(v: Vec3) {
    return v.round();
}

