// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ResearchAnchor — onchain record of Sage research briefs.
/// @notice Stores keccak256(brief JSON) + symbol + timestamp so anyone can verify
/// that a brief existed at a given time and has not been altered. The brief text
/// itself stays offchain (in the public GitHub repo / X post); only its hash is
/// anchored. No funds, no trading, no custody — a pure provenance record.
/// @dev Deploy target: Base Sepolia testnet first (testnet submissions are
/// explicitly NOT judged less favorably by the Stocks Maxxing rules).
contract ResearchAnchor {
    struct Brief {
        address author;
        string symbol;
        bytes32 briefHash;
        uint256 timestamp;
    }

    Brief[] public briefs;
    mapping(bytes32 => bool) public anchored;

    event BriefAnchored(uint256 indexed id, address indexed author, string symbol, bytes32 briefHash, uint256 timestamp);

    /// @notice Anchor a brief hash. Reverts if this exact hash is already anchored.
    function anchorBrief(string calldata symbol, bytes32 briefHash) external returns (uint256 id) {
        require(briefHash != bytes32(0), "empty hash");
        require(!anchored[briefHash], "already anchored");
        id = briefs.length;
        briefs.push(Brief({author: msg.sender, symbol: symbol, briefHash: briefHash, timestamp: block.timestamp}));
        anchored[briefHash] = true;
        emit BriefAnchored(id, msg.sender, symbol, briefHash, block.timestamp);
    }

    function briefCount() external view returns (uint256) {
        return briefs.length;
    }
}
