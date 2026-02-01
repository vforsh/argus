/** CDP node shape returned by DOM.describeNode. */
export type CdpNode = {
	nodeId: number
	nodeType: number
	nodeName: string
	localName?: string
	attributes?: string[]
	children?: CdpNode[]
	childNodeCount?: number
}

/** CDP result shape for DOM.describeNode. */
export type CdpDescribeResult = {
	node?: CdpNode
}
